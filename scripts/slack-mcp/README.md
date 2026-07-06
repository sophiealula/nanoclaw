# Slack MCP (read-only) for NanoClaw

Lets the NanoClaw container agent **read** the 2389 Slack workspace ("what
happened in #general yesterday?", "what's the team struggling with?").

## Architecture (mirrors the Horton / credential-proxy pattern)

```
tokens.env (xoxc/xoxd, host-only)
  → korotovsky/slack-mcp-server  (launchd: com.nanoclaw.slack-mcp)
      bound to 192.168.64.1:13080  (Apple Container bridge gateway, NOT 0.0.0.0)
  → container .mcp.json "Slack" {type:http, url, Bearer}  ← written by container-runner.ts
      → agent calls mcp__Slack__*
```

- **Slack session tokens never enter a container.** They live in `tokens.env`
  (chmod 600) and are only read by the server on the host.
- **Not exposed to the LAN.** Bound to the vmnet bridge IP, reachable only from
  container VMs. The `SLACK_MCP_API_KEY` bearer (in `server.env`) is defense-in-depth.
- **Read-only.** `run.sh` whitelists read tools via `SLACK_MCP_ENABLED_TOOLS`;
  write tools (post message, reactions, etc.) are not enabled.

## Files

| File | What |
|------|------|
| `slack-mcp-server-darwin-arm64` | korotovsky binary v1.3.0 (gitignored) |
| `tokens.env` | `SLACK_MCP_XOXC_TOKEN` + `SLACK_MCP_XOXD_TOKEN` (gitignored, 600) |
| `server.env` | `SLACK_MCP_API_KEY` local-gate bearer (gitignored, 600) |
| `run.sh` | launcher: binds bridge IP, read-only whitelist |
| `extract-tokens.mjs` | Playwright token grabber (persistent profile in `.pw-profile/`) |
| `~/Library/LaunchAgents/com.nanoclaw.slack-mcp.plist` | the service |

Wiring on the NanoClaw side: `src/config.ts` (`SLACK_MCP_PORT`) +
`src/container-runner.ts` (adds the `Slack` entry to each group's `.mcp.json`,
self-gated on `tokens.env`/`server.env` existing).

## Token refresh (xoxc/xoxd expire)

Symptom: agent says Slack reads fail / 401, or `logs/slack-mcp.log` shows auth errors.

```bash
node scripts/slack-mcp/extract-tokens.mjs   # re-login in the Chromium window if prompted
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.slack-mcp
```

The `.pw-profile/` keeps you logged in, so most refreshes won't need a re-login.

## Service control

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.slack-mcp   # restart
tail -f logs/slack-mcp.log                                   # logs (in repo logs/)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.slack-mcp.plist  # stop
```
