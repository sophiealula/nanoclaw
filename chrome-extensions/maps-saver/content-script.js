// NanoClaw Maps Saver — content script.
//
// Runs inside maps.google.com pages. Listens for a "save-place" message from
// the background worker, then performs the click-Save → pick-list → fill-note
// flow against the live Maps DOM. Because this runs in Sophie's real Chrome
// session with her real cookies, there's no bot detection — Maps treats it
// exactly like any other Sophie tab.
//
// DOM patterns mirror the ones documented in
// container/skills/pp-google-maps/SKILL.md Sections 5-6.

(() => {
  // Guard: this script may be injected more than once per tab. Only register
  // the listener on the first injection.
  if (window.__nanoclawMapsSaverRegistered) return;
  window.__nanoclawMapsSaverRegistered = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'save-place') return;
    void runSave(msg.item).then(sendResponse);
    return true; // keep the message channel open for async sendResponse
  });

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(predicate, { timeout = 8000, interval = 200 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function findSaveButton() {
    // Maps renders the Save action a few ways depending on A/B variant.
    // All of them surface as a button whose accessible name contains "Save"
    // (or "Saved" if the place is already in a list).
    const selectors = [
      'button[aria-label^="Save "]',
      'button[aria-label^="Saved"]',
      'button[data-tooltip="Save"]',
      'button[aria-label*="Save"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function readSaveState(btn) {
    if (!btn) return 'missing';
    if (btn.getAttribute('aria-pressed') === 'true') return 'saved';
    const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
    if (label.startsWith('saved') || label.includes('remove from')) return 'saved';
    return 'unsaved';
  }

  function findSavedDialog() {
    // Strict: only return dialogs whose aria-label clearly identifies the picker.
    // The previous fallback to "last dialog" was matching the zoom slider —
    // that whole class of false positive is gone here.
    const candidates = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    for (const d of candidates) {
      const label = (d.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('save') && (label.includes('list') || label.includes('place'))) return d;
    }
    return null;
  }

  function findListPickerByContent() {
    // Real Maps picker has "New list" text AND at least one of the system lists
    // (Want to go / Favorites / Starred). Find the smallest visible container
    // matching both — that's our picker, regardless of ARIA role.
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.offsetParent !== null;
    }
    const candidates = document.querySelectorAll('div, ul, section, aside');
    let best = null;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = el.innerText || '';
      if (
        text.includes('New list') &&
        (text.includes('Want to go') || text.includes('Favorites') || text.includes('Starred'))
      ) {
        if (!best || best.contains(el)) best = el;
      }
    }
    return best;
  }

  function listMenuItems(dialog) {
    // Maps' picker A/B-tests roles. Cast wide; dedupe by element identity.
    const selectors = [
      '[role="menuitemcheckbox"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[role="option"]',
      'li[role]',
      'button',
    ];
    const items = [];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of dialog.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        // Skip obvious non-list items: New list / Cancel / Done / etc.
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        if (/^(new list|create|cancel|close|done|back|show slider|hide slider|search|filter)$/i.test(label)) continue;
        // Skip non-checkbox icons that are too small / probably not list rows
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 20) continue;
        seen.add(el);
        items.push(el);
      }
    }
    return items;
  }

  function dumpPickerItems(dialog) {
    return listMenuItems(dialog).slice(0, 30).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
    }));
  }

  function findListByName(dialog, listName) {
    const target = listName.trim().toLowerCase();
    let exact = null, prefix = null, contains = null;
    for (const item of listMenuItems(dialog)) {
      const raw = (item.getAttribute('aria-label') || item.textContent || '').trim().toLowerCase();
      // Strip ", N places" / "(N)" suffixes Maps appends
      const stripped = raw.replace(/,\s*\d+\s+(places?|saved)\s*$/, '').replace(/\s*\(\d+\)\s*$/, '').trim();
      if (stripped === target) { exact = item; break; }
      if (stripped.startsWith(target) && !prefix) prefix = item;
      if (stripped.includes(target) && !contains) contains = item;
    }
    return exact || prefix || contains;
  }

  async function findOrRevealList(dialog, listName) {
    // 1. Direct match first
    let item = findListByName(dialog, listName);
    if (item) return item;

    // 2. If picker has a search/filter input, type the name in
    const filter = dialog.querySelector(
      'input[type="search"], input[type="text"][placeholder*="search" i], input[type="text"][placeholder*="filter" i], input[role="combobox"]'
    );
    if (filter) {
      setNativeValue(filter, listName);
      await sleep(800);
      item = findListByName(dialog, listName);
      if (item) return item;
    }

    // 3. If picker is scrollable, scroll to bottom (older lists may be lazy-loaded)
    const scrollers = [dialog, ...dialog.querySelectorAll('[class*="scroll"], [style*="overflow"]')];
    for (const s of scrollers) {
      try {
        s.scrollTop = s.scrollHeight;
      } catch {}
    }
    await sleep(600);
    item = findListByName(dialog, listName);
    if (item) return item;

    return null;
  }

  function findNewListButton(dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button'));
    return buttons.find((b) => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      return label === 'new list' || label === '+ new list' || label.startsWith('new list');
    });
  }

  function findNoteTextarea(dialog) {
    const tas = Array.from(dialog.querySelectorAll('textarea, [role="textbox"], input[type="text"]'));
    return tas.find((el) => {
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
      return ph.includes('note') || lbl.includes('note');
    });
  }

  function findDoneButton(dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button'));
    return buttons.find((b) => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      return label === 'done' || label === 'close';
    });
  }

  function setNativeValue(el, value) {
    // React/Closure-based fields ignore plain assignments; the only
    // reliable way is to use the prototype setter so the framework's
    // value tracker sees the change.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clickAndWait(el, settleMs = 400) {
    if (!el) return false;
    el.click();
    await sleep(settleMs);
    return true;
  }

  async function runSave(item) {
    try {
      // 1. Wait for the Save button to render on the place panel.
      const saveBtn = await waitFor(findSaveButton, { timeout: 8000 });
      if (!saveBtn) {
        return { status: 'error', reason: 'save-button-not-found' };
      }

      // 2. Idempotency: if already saved, short-circuit.
      const initial = readSaveState(saveBtn);
      if (initial === 'saved') {
        return { status: 'already-saved' };
      }

      // 3. Click Save → wait for the list-picker (NOT necessarily a role=dialog
      // — Maps' picker is often a plain div with menuitemcheckbox children).
      // Use content-based detection: find a visible container that includes
      // both "Want to go" / "Favorites" / "Starred" AND "New list".
      await clickAndWait(saveBtn, 1000);
      const dialog = await waitFor(
        () => findSavedDialog() || findListPickerByContent(),
        { timeout: 10000 },
      );
      if (!dialog) {
        return { status: 'error', reason: 'list-picker-not-found' };
      }
      // Let lazy children settle
      await sleep(800);

      // 4. Find the existing list by name. **Hard rule: never auto-create
      // a duplicate.** If we can't find the target list, ABORT — don't fall
      // through to "create new list" silently. Sophie would rather see an
      // error than wake up to 3 duplicate San Diego lists.
      let listItem = await findOrRevealList(dialog, item.list_name);
      if (!listItem) {
        // Diagnostic dump so Sophie can see what the picker actually shows
        return {
          status: 'error',
          reason: 'list-not-found-in-picker',
          looked_for: item.list_name,
          visible_lists: dumpPickerItems(dialog).slice(0, 25),
          hint: 'Maps picker may have hidden the list (only shows recent). Save manually to bump it to "recent", or rename the list to match exactly.',
        };
      }
      await clickAndWait(listItem, 700);

      // 5. Fill the note (still in the same dialog).
      const liveDialog = findSavedDialog();
      const noteEl = liveDialog ? findNoteTextarea(liveDialog) : null;
      let noteOk = false;
      if (noteEl && item.note) {
        setNativeValue(noteEl, item.note);
        await sleep(400);
        noteOk = true;
      }

      // 6. Close the dialog. Maps auto-saves on close.
      const doneBtn = liveDialog ? findDoneButton(liveDialog) : null;
      if (doneBtn) {
        await clickAndWait(doneBtn, 800);
      } else {
        // Fallback: press Escape.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(600);
      }

      // 7. Verify by re-reading the Save button state.
      const verifyBtn = await waitFor(findSaveButton, { timeout: 3000 });
      const verified = readSaveState(verifyBtn) === 'saved';

      return {
        status: verified ? 'saved' : 'partial',
        note_attached: noteOk,
        verified,
      };
    } catch (e) {
      return { status: 'error', reason: String(e?.message || e) };
    }
  }
})();
