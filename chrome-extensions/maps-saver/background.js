// NanoClaw Maps Saver — background service worker.
//
// Polls the local NanoClaw HTTP queue every few seconds. When NanoClaw queues
// a save intent (after Sophie's "yes" in Telegram), this worker:
//   1. Opens / focuses a tab pointing at the place's Maps URL.
//   2. Injects the content script, which does the actual click-Save flow.
//   3. POSTs the outcome (success / partial / failed) back to NanoClaw's queue.
//
// Why a Chrome extension at all? Google's bot detection blocks Playwright
// driving Maps even with the right cookies. Running inside Sophie's real
// signed-in Chrome bypasses every layer of that detection — there's no
// automation framework attached, no `navigator.webdriver`, no DevTools
// Protocol fingerprint.

const QUEUE_BASE = 'http://localhost:7733';
const POLL_INTERVAL_SEC = 4;

// In-flight items, keyed by id. Don't reprocess.
const inFlight = new Set();

// Set up the polling alarm on install + on startup.
chrome.runtime.onInstalled.addListener(() => scheduleAlarm());
chrome.runtime.onStartup.addListener(() => scheduleAlarm());

function scheduleAlarm() {
  chrome.alarms.create('poll-queue', {
    periodInMinutes: POLL_INTERVAL_SEC / 60,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll-queue') void pollQueue();
});

async function pollQueue() {
  let items;
  try {
    const res = await fetch(`${QUEUE_BASE}/queue`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      // NanoClaw not running, or the queue endpoint is unreachable. Quiet skip.
      return;
    }
    items = await res.json();
  } catch (e) {
    // Localhost connection refused → NanoClaw down. Quiet skip.
    return;
  }

  if (!Array.isArray(items) || items.length === 0) return;

  for (const item of items) {
    if (inFlight.has(item.id)) continue;
    inFlight.add(item.id);
    void processItem(item).finally(() => inFlight.delete(item.id));
  }
}

async function processItem(item) {
  // item shape: { id, place_url, list_name, list_exists, note, place_name, place_address }
  console.log('[maps-saver] processing', item.id, item.place_name);
  try {
    const tab = await chrome.tabs.create({
      url: item.place_url,
      active: false, // background tab so Sophie doesn't lose focus
    });
    // Wait for the tab to finish loading before injecting the content script.
    await waitForTabComplete(tab.id);
    // Inject the content script and pass the item as a global.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js'],
    });
    // Tell the content script what to save (via a message it listens for).
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'save-place',
      item,
    });
    await reportResult(item.id, result);
    // Close the tab once we're done so Sophie's Chrome stays clean.
    if (result?.status === 'saved' || result?.status === 'already-saved') {
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 1500);
    }
  } catch (e) {
    console.error('[maps-saver] failed', item.id, e);
    await reportResult(item.id, {
      status: 'error',
      reason: String(e?.message || e),
    });
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Maps is JS-heavy. Give it 2s for the place card + Save button to settle.
        setTimeout(resolve, 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function reportResult(id, result) {
  try {
    await fetch(`${QUEUE_BASE}/queue/${encodeURIComponent(id)}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch (e) {
    console.error('[maps-saver] failed to report result', id, e);
  }
}
