#!/usr/bin/env bash
# NanoClaw Maps Saver — self-install script.
#
# Loads the extension into your local Google Chrome using macOS UI automation.
# Run once after cloning, and again if you reinstall Chrome.
#
# Usage:
#   ./install.sh            — full auto-install
#   ./install.sh --dry-run  — print steps without touching Chrome
#
# Requirements:
#   - macOS 13+ (Ventura) with System Events scripting enabled
#   - Google Chrome installed at /Applications/Google Chrome.app
#   - Accessibility permissions for Terminal (System Preferences → Privacy & Security → Accessibility)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR"
DRY_RUN=false

for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

echo "╔══════════════════════════════════════════════╗"
echo "║   NanoClaw Maps Saver — Chrome Extension     ║"
echo "╚══════════════════════════════════════════════╝"
echo
echo "  Extension: $EXT_DIR"
echo

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY RUN — no changes will be made]"
  echo
fi

# ── Preflight ────────────────────────────────────────────────────────────────

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo "ERROR: Google Chrome not found at /Applications/Google Chrome.app" >&2
  exit 1
fi

if [[ ! -f "$EXT_DIR/manifest.json" ]]; then
  echo "ERROR: manifest.json not found in $EXT_DIR" >&2
  echo "       Run this script from within the chrome-extensions/maps-saver/ directory." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  Would open Chrome → chrome://extensions → enable dev mode → Load unpacked"
  echo "  Extension dir: $EXT_DIR"
  echo
  echo "  Dry run complete."
  exit 0
fi

# ── Copy path to clipboard (fallback if automation misfires) ─────────────────
echo "$EXT_DIR" | pbcopy
echo "  ✓ Extension path copied to clipboard (fallback if file picker needs it)"
echo

# ── Step 1: Open Chrome and navigate to chrome://extensions ──────────────────
echo "  → Opening Chrome…"
osascript <<'APPLESCRIPT'
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then
    make new window
  end if
  -- Open extensions page in a new tab so we don't clobber whatever Sophie has open.
  tell front window
    set newTab to make new tab at end of tabs
    set URL of newTab to "chrome://extensions/"
    set active tab index to (count of tabs)
  end tell
end tell
APPLESCRIPT

sleep 2

# ── Step 2: Enable Developer Mode via JavaScript shadow DOM traversal ─────────
echo "  → Enabling Developer Mode…"
osascript <<'APPLESCRIPT'
tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "
        (function() {
          const mgr = document.querySelector('extensions-manager');
          if (!mgr || !mgr.shadowRoot) return 'no-manager';
          const toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
          if (!toolbar || !toolbar.shadowRoot) return 'no-toolbar';
          const toggle = toolbar.shadowRoot.querySelector('#devMode');
          if (!toggle) return 'no-toggle';
          if (!toggle.checked) {
            toggle.click();
            return 'enabled';
          }
          return 'already-enabled';
        })()
      "
    end tell
  end tell
end tell
APPLESCRIPT

sleep 1

# ── Step 3: Click the "Load unpacked" button ──────────────────────────────────
echo "  → Clicking 'Load unpacked'…"
osascript <<'APPLESCRIPT'
tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "
        (function() {
          const mgr = document.querySelector('extensions-manager');
          if (!mgr || !mgr.shadowRoot) return 'no-manager';
          const toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
          if (!toolbar || !toolbar.shadowRoot) return 'no-toolbar';
          const btn = toolbar.shadowRoot.querySelector('#loadUnpackedButton, [id*='load'], button[aria-label*='Load unpacked'], cr-button');
          // Try all buttons and find the one with load-unpacked text
          const buttons = Array.from(toolbar.shadowRoot.querySelectorAll('cr-button, button'));
          const loadBtn = buttons.find(b => (b.textContent || '').trim().toLowerCase().includes('load unpacked'));
          if (loadBtn) { loadBtn.click(); return 'clicked'; }
          return 'button-not-found';
        })()
      "
    end tell
  end tell
end tell
APPLESCRIPT

sleep 1

# ── Step 4: Handle the native file picker with System Events ──────────────────
echo "  → Navigating file picker to extension directory…"
osascript - "$EXT_DIR" <<'APPLESCRIPT'
on run argv
  set extDir to item 1 of argv
  tell application "System Events"
    -- Wait for the file picker dialog to appear (Chrome's "Select Extension Directory")
    set maxWait to 8
    set waited to 0
    set pickerVisible to false
    repeat while waited < maxWait
      delay 0.5
      set waited to waited + 0.5
      tell process "Google Chrome"
        if (count of sheets of front window) > 0 then
          set pickerVisible to true
          exit repeat
        end if
      end tell
    end repeat

    if not pickerVisible then
      -- Try Cmd+Shift+G in whatever dialog is open (often works without sheet detection)
      tell process "Google Chrome"
        keystroke "g" using {command down, shift down}
        delay 0.5
        keystroke extDir
        delay 0.3
        key code 36 -- Return
        delay 0.5
        key code 36 -- Return again (confirm "Open" / "Select")
      end tell
      return "used-fallback-keystroke"
    end if

    -- Dialog found — use Cmd+Shift+G to "Go to Folder"
    tell process "Google Chrome"
      keystroke "g" using {command down, shift down}
      delay 0.5
      keystroke extDir
      delay 0.3
      key code 36 -- Return (accepts the typed path in the Go to Folder sheet)
      delay 0.5
      key code 36 -- Return / click "Select Folder" button
    end tell
  end tell
end run
APPLESCRIPT

sleep 1.5

# ── Step 5: Verify the extension loaded ──────────────────────────────────────
echo "  → Verifying installation…"
RESULT=$(osascript <<'APPLESCRIPT'
tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "
        (function() {
          const mgr = document.querySelector('extensions-manager');
          if (!mgr || !mgr.shadowRoot) return JSON.stringify({found: false, reason: 'no-manager'});
          const itemList = mgr.shadowRoot.querySelector('extensions-item-list');
          if (!itemList || !itemList.shadowRoot) return JSON.stringify({found: false, reason: 'no-item-list'});
          const items = itemList.shadowRoot.querySelectorAll('extensions-item');
          for (const item of items) {
            if (!item.shadowRoot) continue;
            const nameEl = item.shadowRoot.querySelector('#name');
            if (nameEl && nameEl.textContent.includes('Maps Saver')) {
              return JSON.stringify({found: true, name: nameEl.textContent.trim()});
            }
          }
          return JSON.stringify({found: false, reason: 'not-in-list'});
        })()
      "
    end tell
  end tell
end tell
APPLESCRIPT
)

echo
if echo "$RESULT" | grep -q '"found":true'; then
  echo "  ✅ NanoClaw Maps Saver is installed and showing in Chrome!"
  echo
  echo "  Click the extension icon (puzzle piece → Maps Saver) to verify"
  echo "  it shows 'Connected ✓' — that means NanoClaw's queue server is running."
  echo
else
  echo "  ⚠️  Could not confirm the extension in the list."
  echo "     It may have loaded anyway (Chrome's shadow DOM can be slow to update)."
  echo
  echo "  If it didn't load, install manually in 3 clicks:"
  echo "    1. chrome://extensions → enable Developer mode (top-right toggle)"
  echo "    2. Click 'Load unpacked'"
  echo "    3. Navigate to: $EXT_DIR"
  echo "       (already copied to your clipboard)"
  echo
fi
