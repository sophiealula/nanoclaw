#!/bin/bash
# Snack bot setup: verify env, install Playwright, optional launchd registration.
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="$PROJECT_DIR/.claude/skills/add-snack-bot"
ENV_FILE="$HOME/.instacart-mcp/.env"
PROFILE_DIR="$HOME/.instacart-mcp/profile"

echo "=== snack-bot setup ==="
echo "project: $PROJECT_DIR"
echo "skill:   $SKILL_DIR"
echo

# 1. env file
mkdir -p "$HOME/.instacart-mcp"
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠  $ENV_FILE missing"
  echo "   create it with: SLACK_BOT_TOKEN, SLACK_DM_CHANNEL_ID, SLACK_OWNER_USER_ID, SLACK_BOT_USER_ID"
  echo "   see SKILL.md Phase 3 for the Slack app setup"
  exit 1
fi
chmod 600 "$ENV_FILE"
for k in SLACK_BOT_TOKEN SLACK_DM_CHANNEL_ID SLACK_OWNER_USER_ID SLACK_BOT_USER_ID; do
  grep -q "^${k}=" "$ENV_FILE" || { echo "⚠  $ENV_FILE missing key: $k"; exit 1; }
done
echo "✓ env: all four Slack keys present"

# 2. Instacart profile
if [ ! -d "$PROFILE_DIR" ]; then
  echo "⚠  no Instacart session captured at $PROFILE_DIR"
  echo "   run: npx tsx $SKILL_DIR/scripts/instacart-auth.ts"
  exit 1
fi
echo "✓ instacart: profile dir exists ($(ls -la "$PROFILE_DIR" | wc -l | xargs) entries)"

# 3. Playwright + chromium
cd "$PROJECT_DIR"
if ! node -e "require('playwright')" 2>/dev/null; then
  echo "→ installing playwright..."
  npm install playwright >/dev/null 2>&1
fi
if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "→ installing chromium binary..."
  npx playwright install chromium >/dev/null 2>&1
fi
echo "✓ playwright + chromium installed"

# 4. Verify auth token + look up bot user id (sanity)
TOKEN=$(grep "^SLACK_BOT_TOKEN=" "$ENV_FILE" | cut -d= -f2)
WHOAMI=$(curl -sS -H "Authorization: Bearer $TOKEN" https://slack.com/api/auth.test)
if echo "$WHOAMI" | grep -q '"ok":true'; then
  USER=$(echo "$WHOAMI" | grep -oE '"user":"[^"]+"' | cut -d\" -f4)
  BOT_USER_ID=$(echo "$WHOAMI" | grep -oE '"user_id":"[^"]+"' | cut -d\" -f4)
  echo "✓ slack token valid (bot user: $USER / $BOT_USER_ID)"
else
  echo "⚠  slack auth.test failed: $WHOAMI"
  exit 1
fi

# 5. Suggest launchd or manual launch
echo
echo "=== next ==="
echo "to run under launchd (auto-restart on reboot/crash):"
echo "  sed \"s|__HOME__|\$HOME|g; s|__PROJECT__|$PROJECT_DIR|g\" \\"
echo "    $SKILL_DIR/com.snackbot.plist.template \\"
echo "    > ~/Library/LaunchAgents/com.snackbot.plist"
echo "  launchctl load ~/Library/LaunchAgents/com.snackbot.plist"
echo
echo "to run manually (no auto-restart):"
echo "  nohup npx tsx $SKILL_DIR/scripts/snack-bot.ts > /tmp/snack-bot.log 2>&1 &"
echo
echo "to verify after starting:"
echo "  tail -f /tmp/snack-bot.log"
