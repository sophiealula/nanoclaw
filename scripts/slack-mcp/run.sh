#!/usr/bin/env bash
# Launches korotovsky/slack-mcp-server as a streamable-HTTP MCP, read-only.
#
# Security model (mirrors NanoClaw's credential proxy, src/container-runtime.ts):
# bind to the Apple Container bridge gateway IP (192.168.64.1), NOT 0.0.0.0.
# That subnet is reachable from container VMs but not the broader LAN, so Slack
# read access is never exposed to the network. The bearer key is defense-in-depth.
#
# Slack session tokens live in tokens.env and never enter a container.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
source "$HERE/tokens.env"   # SLACK_MCP_XOXC_TOKEN, SLACK_MCP_XOXD_TOKEN
source "$HERE/server.env"   # SLACK_MCP_API_KEY (local gate)
set +a

# v1.3.0 reads SLACK_MCP_SSE_API_KEY; newer builds read SLACK_MCP_API_KEY. Set both.
export SLACK_MCP_SSE_API_KEY="${SLACK_MCP_SSE_API_KEY:-$SLACK_MCP_API_KEY}"
export SLACK_MCP_API_KEY

# Bind to the bridge gateway so only container VMs can reach it. Detect the live
# bridge IP; fall back to Apple Container's default. (launchd KeepAlive retries
# until the bridge exists if we start before the container runtime.)
DETECTED="$(ifconfig bridge100 2>/dev/null | awk '/inet /{print $2; exit}')"
export SLACK_MCP_HOST="${SLACK_MCP_HOST:-${DETECTED:-192.168.64.1}}"
export SLACK_MCP_PORT="${SLACK_MCP_PORT:-13080}"

# Read-only whitelist. Write/action tools (conversations_add_message, reactions_*,
# conversations_mark, usergroups_*, saved_update/clear) are omitted AND not enabled.
export SLACK_MCP_ENABLED_TOOLS="conversations_history,conversations_replies,conversations_search_messages,channels_list,users_search,usergroups_list,usergroups_me,conversations_unreads,saved_list"

exec "$HERE/slack-mcp-server-darwin-arm64" -t http
