#!/bin/bash
# Daily msgvault sync: incremental email + iMessage/SMS import.
# Invoked by launchd (~/Library/LaunchAgents/com.msgvault.sync.plist).
# iMessage import requires Full Disk Access granted to the msgvault binary.

set -o pipefail

MSGVAULT="/Users/sophiedavis/.local/bin/msgvault"
LOG="/Users/sophiedavis/.msgvault/sync.log"

mkdir -p "$(dirname "$LOG")"

{
  echo "===== $(date -Iseconds) msgvault sync start ====="

  echo "--- msgvault sync (email) ---"
  "$MSGVAULT" sync
  echo "email exit: $?"

  echo "--- msgvault import-imessage ---"
  "$MSGVAULT" import-imessage
  echo "imessage exit: $?"

  echo "===== $(date -Iseconds) msgvault sync done ====="
  echo
} >> "$LOG" 2>&1
