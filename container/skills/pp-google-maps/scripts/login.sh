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

SESSION="gmaps-login-$(date +%s)"

cleanup() {
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Opening Google Maps in a headed Chromium window."
echo "    Sign in to your PERSONAL Google account when the window appears."
agent-browser --session "$SESSION" open "https://www.google.com/maps" --headed >/dev/null

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

echo "==> Saving Playwright state to $STATE_FILE ..."
agent-browser --session "$SESSION" state save "$STATE_FILE"

# Sanity check — file should be > 1KB, hold cookies, and have google.com origin
if [[ ! -s "$STATE_FILE" ]]; then
  echo "ERROR: state file is empty — save failed." >&2
  exit 1
fi

if ! grep -q "google.com" "$STATE_FILE" 2>/dev/null; then
  echo "WARNING: state file has no google.com cookies. Login may not have stuck." >&2
  echo "         Try again — make sure you actually signed in before pressing Enter." >&2
  exit 1
fi

echo
echo "✓ Saved to $STATE_FILE"
echo "  Container will pick this up on its next start. If a container is running,"
echo "  it'll see the file on next mount refresh — restart NanoClaw to be safe:"
echo
echo "    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo
