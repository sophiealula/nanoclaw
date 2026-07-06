#!/bin/bash
# Runs a cloudflared quick tunnel for the Twilio Voice webhook server.
# Parses the assigned URL and updates the Twilio phone number webhooks automatically.
# Designed to run as a launchd service — restarts on failure, re-registers URL each time.

set -euo pipefail

# Load env vars
ENV_FILE="$(dirname "$0")/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

WEBHOOK_PORT="${TWILIO_WEBHOOK_PORT:-3100}"
ACCOUNT_SID="${TWILIO_ACCOUNT_SID:?Missing TWILIO_ACCOUNT_SID}"
AUTH_TOKEN="${TWILIO_AUTH_TOKEN:?Missing TWILIO_AUTH_TOKEN}"
PHONE_NUMBER="${TWILIO_PHONE_NUMBER:?Missing TWILIO_PHONE_NUMBER}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Look up the phone number SID once
PHONE_SID=$(curl -sf "https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PHONE_NUMBER}'))")" \
  -u "${ACCOUNT_SID}:${AUTH_TOKEN}" | python3 -c "import sys,json; print(json.load(sys.stdin)['incoming_phone_numbers'][0]['sid'])")

log "Phone number SID: $PHONE_SID"

update_twilio_webhooks() {
  local tunnel_url="$1"
  log "Updating Twilio webhooks to: $tunnel_url"
  curl -sf -X POST "https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers/${PHONE_SID}.json" \
    -u "${ACCOUNT_SID}:${AUTH_TOKEN}" \
    -d "VoiceUrl=${tunnel_url}/voice/incoming" \
    -d "VoiceMethod=POST" \
    -d "StatusCallback=${tunnel_url}/voice/status" \
    -d "StatusCallbackMethod=POST" > /dev/null
  log "Twilio webhooks updated successfully"

  # Also update .env so NanoClaw reads the current URL on restart
  if [[ -f "$ENV_FILE" ]]; then
    sed -i '' "s|^TWILIO_WEBHOOK_BASE_URL=.*|TWILIO_WEBHOOK_BASE_URL=${tunnel_url}|" "$ENV_FILE"
  fi
}

# Start cloudflared and watch its stderr for the tunnel URL
log "Starting cloudflared tunnel on port $WEBHOOK_PORT"
cloudflared tunnel --url "http://localhost:${WEBHOOK_PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  # Parse the tunnel URL from cloudflared output
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    TUNNEL_URL="${BASH_REMATCH[0]}"
    log "Tunnel URL detected: $TUNNEL_URL"
    update_twilio_webhooks "$TUNNEL_URL" &
  fi
done
