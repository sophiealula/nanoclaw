#!/usr/bin/env bash
# One-time (and on-expiry) login ceremony for the pp-google-maps skill.
#
# Opens a real Chromium window so Soph can sign in to her PERSONAL Google
# account manually, then snapshots the Playwright storage state to a file
# that the container mounts at /home/node/.config/google-maps/state.json.
#
# Re-run this whenever the in-container skill reports "Maps session expired."

set -euo pipefail

STATE_DIR="$HOME/Library/Application Support/nanoclaw/google-maps"
STATE_FILE="$STATE_DIR/state.json"

mkdir -p "$STATE_DIR"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "ERROR: agent-browser CLI not found on PATH." >&2
  echo "Install it first — it's the same tool the container uses." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found on PATH." >&2
  echo "Install it: brew install jq" >&2
  exit 1
fi

SESSION="gmaps-login-$(date +%s)"

cleanup() {
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
}
# trap fires AFTER explicit close in success path, so save+verify always run first
trap cleanup EXIT

echo "==> Opening Google Maps in a headed Chromium window."
echo "    Sign in to your PERSONAL Google account when the window appears."
# --headed as a global flag (before subcommand) per agent-browser canonical usage
agent-browser --session "$SESSION" --headed open "https://www.google.com/maps" >/dev/null

cat <<EOF

==> Now in the browser window:
    1. Sign in to your PERSONAL Google account (NOT sophie@2389.ai).
    2. Click into "Saved" / your saved lists — confirm you see your city lists.
    3. Open one list and verify a place loads correctly.
    4. Come back here and press Enter.

    If Google challenges the login (CAPTCHA, "verify it's you"), complete it
    in the window like normal. Don't close the window until you press Enter.

EOF

read -r -p "Press Enter once you're signed in and Maps is working: " _

# Pull the active account label — confirms signed-in + which account.
ACCOUNT_LABEL=$(agent-browser --session "$SESSION" eval \
  "document.querySelector('a[aria-label*=\"Google Account\"], a[aria-label*=\"account\"]')?.getAttribute('aria-label') || ''" \
  2>/dev/null || echo "")

if [[ -z "$ACCOUNT_LABEL" ]]; then
  echo "ERROR: couldn't read account chip — you're not signed in, or Maps hasn't rendered yet." >&2
  echo "       Sign in fully, click around Maps to confirm it loads, then re-run this script." >&2
  exit 1
fi

if echo "$ACCOUNT_LABEL" | grep -qiE "2389\.ai|sophie@2389"; then
  echo "ERROR: signed in to WORK account (2389.ai). Switch to personal in the window," >&2
  echo "       click around to confirm, then re-run this script." >&2
  exit 1
fi

# Show account once + save. No second confirmation prompt — the regex above
# already blocks the dangerous case (work account); any other gmail is
# implicitly approved.
echo
echo "==> Account: ${ACCOUNT_LABEL%%@*}@…  (saving)"
agent-browser --session "$SESSION" state save "$STATE_FILE"

# Sanity check: file is non-empty AND has at least one Google cookie.
# Don't validate specific cookie names — Google rotates those occasionally
# and the per-name check would create false negatives.
if [[ ! -s "$STATE_FILE" ]]; then
  echo "ERROR: state file is empty — save failed." >&2
  exit 1
fi
GOOGLE_COOKIES=$(jq -r '[.cookies[] | select(.domain | endswith(".google.com"))] | length' "$STATE_FILE")
if [[ "$GOOGLE_COOKIES" -lt 1 ]]; then
  echo "ERROR: state file has no google.com cookies. You weren't actually signed in." >&2
  exit 1
fi

echo
echo "✓ Saved $GOOGLE_COOKIES google.com cookies to $STATE_FILE"
echo
echo "  Container will pick this up on its next start. If a container is running,"
echo "  it'll see the file on next mount refresh — restart NanoClaw to be safe:"
echo
echo "    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo
