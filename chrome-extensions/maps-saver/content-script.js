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
    // The list-picker is a role=dialog. Its aria-label varies but always
    // contains "Save" (e.g. "Save in your lists").
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      const label = (d.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('save')) return d;
    }
    // Fallback: pick the most recently-opened visible dialog.
    return dialogs[dialogs.length - 1] || null;
  }

  function listMenuItems(dialog) {
    // Each existing list is a role=menuitemcheckbox inside the dialog.
    return Array.from(dialog.querySelectorAll('[role="menuitemcheckbox"]'));
  }

  function findListByName(dialog, listName) {
    const target = listName.trim().toLowerCase();
    let exact = null, partial = null;
    for (const item of listMenuItems(dialog)) {
      const name = (item.getAttribute('aria-label') || item.textContent || '').trim().toLowerCase();
      // Strip trailing " , N places" suffix Maps appends
      const stripped = name.replace(/,\s*\d+\s+places?$/, '').trim();
      if (stripped === target) { exact = item; break; }
      if (stripped.startsWith(target) && !partial) partial = item;
    }
    return exact || partial;
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

      // 3. Click Save → wait for the list-picker dialog.
      await clickAndWait(saveBtn, 700);
      const dialog = await waitFor(findSavedDialog, { timeout: 5000 });
      if (!dialog) {
        return { status: 'error', reason: 'list-picker-dialog-not-found' };
      }

      // 4. Pick or create the list.
      let listItem = findListByName(dialog, item.list_name);
      if (!listItem) {
        // Need to create a new list.
        const newListBtn = findNewListButton(dialog);
        if (!newListBtn) {
          return { status: 'error', reason: 'new-list-button-not-found' };
        }
        await clickAndWait(newListBtn, 500);
        // After "New list" click, a fresh dialog/section appears with a text
        // input for the list name. Find the first text input in the dialog
        // (or the page), fill the list name, click "Create" / "Save".
        const nameInput = await waitFor(
          () => document.querySelector('input[type="text"]:not([disabled]), [role="textbox"][contenteditable="true"]'),
          { timeout: 3000 },
        );
        if (!nameInput) {
          return { status: 'error', reason: 'new-list-name-input-not-found' };
        }
        setNativeValue(nameInput, item.list_name);
        await sleep(300);
        // Find a "Create" or "Save" button on the new-list form.
        const submit = Array.from(document.querySelectorAll('button')).find((b) => {
          const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
          return label === 'create' || label === 'save';
        });
        if (!submit) {
          return { status: 'error', reason: 'new-list-create-button-not-found' };
        }
        await clickAndWait(submit, 700);
        // After creation, the picker re-opens (or we're already saved into it).
        // Re-find the dialog + the list item to verify.
        await waitFor(() => {
          const d = findSavedDialog();
          return d && findListByName(d, item.list_name);
        }, { timeout: 5000 });
      } else {
        // Existing list — tick it.
        await clickAndWait(listItem, 600);
      }

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
