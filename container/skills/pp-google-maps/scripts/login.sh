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

# Pull the active account label BEFORE saving state — so we can verify it's
# the personal account, not the work account.
ACCOUNT_LABEL=$(agent-browser --session "$SESSION" eval \
  "document.querySelector('a[aria-label*=\"Google Account\"], a[aria-label*=\"account\"]')?.getAttribute('aria-label') || ''" \
  2>/dev/null || echo "")

if [[ -z "$ACCOUNT_LABEL" ]]; then
  echo "WARNING: couldn't read account chip — Maps may not have rendered yet, or you're not signed in." >&2
  echo "         Sign in fully, click around Maps to confirm it loads, then re-run this script." >&2
  exit 1
fi

echo
echo "==> Detected account: $ACCOUNT_LABEL"
if echo "$ACCOUNT_LABEL" | grep -qiE "2389\.ai|sophie@2389"; then
  echo "ERROR: signed in to the WORK account (2389.ai). The pp-google-maps skill" >&2
  echo "       is meant for your PERSONAL account. Switch accounts in the window," >&2
  echo "       click around to confirm, and re-run this script." >&2
  exit 1
fi

read -r -p "Is this the right (personal) account? [y/N]: " account_ok
if [[ ! "$account_ok" =~ ^[Yy]$ ]]; then
  echo "Aborted — switch accounts and re-run."
  exit 1
fi

echo "==> Saving Playwright state to $STATE_FILE ..."
agent-browser --session "$SESSION" state save "$STATE_FILE"

# Sanity check: file is non-empty
if [[ ! -s "$STATE_FILE" ]]; then
  echo "ERROR: state file is empty — save failed." >&2
  exit 1
fi

# Strong cookie check: state must contain at least one Google auth cookie.
# These names are stable across Google's account rotations (SID/HSID/SSID are
# the canonical session-auth cookies; __Secure-*PSID are the post-2019 variants).
AUTH_COOKIES=$(jq -r '
  [.cookies[]
   | select((.domain | endswith(".google.com")) and
            (.name | IN("SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID")))]
  | length
' "$STATE_FILE")

if [[ "$AUTH_COOKIES" -lt 1 ]]; then
  echo "ERROR: state file has no Google auth cookies (SID/HSID/SSID/__Secure-*PSID)." >&2
  echo "       The save ran, but you weren't actually signed in. Sign in fully and re-run." >&2
  exit 1
fi

echo
echo "✓ Saved $AUTH_COOKIES Google auth cookies to $STATE_FILE"
echo "  Account: $ACCOUNT_LABEL"
echo
echo "  Container will pick this up on its next start. If a container is running,"
echo "  it'll see the file on next mount refresh — restart NanoClaw to be safe:"
echo
echo "    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo
