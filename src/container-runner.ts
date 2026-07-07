/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  HORTON_MCP_URL,
  IDLE_TIMEOUT,
  PROJECT_ROOT,
  SLACK_MCP_PORT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  bindMountArgs,
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const homeDir = process.env.HOME || '/root';
  const gsuiteCfgDir = path.join(homeDir, '.config', 'gsuite-mcp');
  const gsuiteDataDir = path.join(homeDir, '.local', 'share', 'gsuite-mcp');
  const msgvaultDir = path.join(homeDir, '.msgvault');
  // instacart-pp-cli stores config + history DB in macOS Application Support;
  // Linux container expects it under XDG ($HOME/.config/instacart).
  const instacartHostDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'instacart',
  );
  // amazon-pp-cli mirrors the instacart pattern: macOS Application Support on host,
  // XDG ($HOME/.config/amazon-pp-cli) inside the Linux container.
  const amazonHostDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'amazon-pp-cli',
  );
  // pp-google-maps stores the Playwright auth state for Soph's personal
  // Google account. The skill (SKILL.md) drives Maps via agent-browser using
  // this state. Refreshed by the host-side login ceremony in
  // container/skills/pp-google-maps/scripts/login.sh.
  const googleMapsHostDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'nanoclaw',
    'google-maps',
  );
  // pp-google-maps queue (Chrome-extension-driven save path).
  // The skill writes save intents to pending/ here; the host's HTTP server
  // exposes them to the Chrome extension. The skill polls results/ for
  // outcomes. See src/maps-queue.ts.
  const mapsQueueHostDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'nanoclaw',
    'maps-queue',
  );
  // Sophie's taste profile docs — feeds the taste-aware-event-scout skill.
  const tasteProfileDir = path.join(
    homeDir,
    'projects',
    'personal',
    'taste-profile',
  );

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // .env shadowing is handled inside the container entrypoint via mount --bind
    // (Apple Container only supports directory mounts, not file mounts like /dev/null)

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
          // Auto-approve MCP servers from project .mcp.json (gsuite, etc.)
          enableAllProjectMcpServers: true,
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Write .mcp.json for MCP servers available inside the container
  // Must be in the group dir (container cwd = /workspace/group/) so Claude Code finds it
  const mcpFile = path.join(groupDir, '.mcp.json');
  const mcpConfig: Record<string, unknown> = {};
  // GSuite MCP servers (if credentials are mounted)
  // Single GSuite MCP server with multi-account support.
  // Tools accept an `account` parameter (e.g. "default" or "personal").
  // accounts.json maps aliases to container token paths.
  if (fs.existsSync(gsuiteCfgDir) && fs.existsSync(gsuiteDataDir)) {
    const gsuiteConfigCopy = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'gsuite-config',
    );

    // Write container-compatible accounts.json
    const containerAccounts: {
      default: string;
      accounts: Record<string, { token_path: string }>;
    } = {
      default: 'default',
      accounts: {
        default: {
          token_path: '/home/node/.local/share/gsuite-mcp/token.json',
        },
      },
    };
    const tokensDir = path.join(gsuiteDataDir, 'tokens');
    if (fs.existsSync(tokensDir)) {
      for (const file of fs.readdirSync(tokensDir)) {
        const account = file.replace(/\.json$/, '');
        containerAccounts.accounts[account] = {
          token_path: `/home/node/.local/share/gsuite-mcp/tokens/${file}`,
        };
      }
    }
    fs.mkdirSync(gsuiteConfigCopy, { recursive: true });
    fs.writeFileSync(
      path.join(gsuiteConfigCopy, 'accounts.json'),
      JSON.stringify(containerAccounts, null, 2) + '\n',
    );

    // Copy credentials.json
    const credsSrc = path.join(gsuiteCfgDir, 'credentials.json');
    const credsDst = path.join(gsuiteConfigCopy, 'credentials.json');
    if (fs.existsSync(credsSrc)) {
      fs.copyFileSync(credsSrc, credsDst);
    }

    mcpConfig['gsuite'] = {
      command: '/usr/local/bin/gsuite-mcp',
      args: ['mcp'],
    };
  }
  // msgvault MCP server (email/iMessage archive search)
  if (
    fs.existsSync(msgvaultDir) &&
    fs.existsSync(path.join(msgvaultDir, 'msgvault.db'))
  ) {
    mcpConfig['msgvault'] = {
      command: '/usr/local/bin/msgvault',
      args: ['mcp'],
    };
  }
  // Horton fleet MCP server (HTTP, over Tailscale/LAN). No credentials needed.
  if (HORTON_MCP_URL) {
    mcpConfig['Horton'] = {
      type: 'http',
      url: HORTON_MCP_URL,
    };
  }
  // Slack MCP server (read-only, korotovsky/slack-mcp-server). Runs on the host
  // bound to the container bridge gateway; Slack session tokens stay host-side.
  // Only wired in if setup has run (server.env holds the local-gate bearer key).
  if (SLACK_MCP_PORT) {
    const slackEnvFile = path.join(
      PROJECT_ROOT,
      'scripts',
      'slack-mcp',
      'server.env',
    );
    const slackTokensFile = path.join(
      PROJECT_ROOT,
      'scripts',
      'slack-mcp',
      'tokens.env',
    );
    if (fs.existsSync(slackEnvFile) && fs.existsSync(slackTokensFile)) {
      const m = fs
        .readFileSync(slackEnvFile, 'utf8')
        .match(/^SLACK_MCP_API_KEY=(.+)$/m);
      const slackKey = m?.[1]?.trim();
      if (slackKey) {
        mcpConfig['Slack'] = {
          type: 'http',
          url: `http://${CONTAINER_HOST_GATEWAY}:${SLACK_MCP_PORT}/mcp`,
          headers: { Authorization: `Bearer ${slackKey}` },
        };
      }
    }
  }
  if (Object.keys(mcpConfig).length > 0) {
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: mcpConfig }, null, 2) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/.
  // preserveTimestamps is LOAD-BEARING: without it, every container start
  // rewrites all SKILL.md mtimes to "now", which makes agent-runner's
  // skill-changed-since-session-start check trigger spuriously and silently
  // drop the session. That manifests as "the agent forgot what we were
  // talking about" after a container restart. (Bug found 2026-05-22 during
  // the pp-google-maps batch-save investigation.)
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true, preserveTimestamps: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Check freshness by comparing the MAX mtime across ALL files in src to
    // the cached copy. The previous version only checked index.ts, which meant
    // edits to sibling files (e.g. ipc-mcp-stdio.ts) didn't invalidate the
    // cache and containers ran stale code — caused a same-orphan surrogate
    // 400 to recur in 2026-05-16 after the safeSlice fix had been "deployed."
    const maxMtime = (dir: string): number => {
      let max = 0;
      for (const name of fs.readdirSync(dir)) {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile() && stat.mtimeMs > max) max = stat.mtimeMs;
      }
      return max;
    };
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      fs.readdirSync(groupAgentRunnerDir).length === 0 ||
      maxMtime(agentRunnerSrc) > maxMtime(groupAgentRunnerDir);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount GSuite MCP credentials so container agent can access Gmail/Calendar.
  // Config (accounts.json + credentials.json) is prepared in the .mcp.json section above.
  // Data dir (tokens) is mounted read-only.
  if (fs.existsSync(gsuiteCfgDir) && fs.existsSync(gsuiteDataDir)) {
    const gsuiteConfigCopy = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'gsuite-config',
    );
    mounts.push({
      hostPath: gsuiteConfigCopy,
      containerPath: '/home/node/.config/gsuite-mcp',
      readonly: true,
    });
    mounts.push({
      hostPath: gsuiteDataDir,
      containerPath: '/home/node/.local/share/gsuite-mcp',
      readonly: true,
    });
  }

  // Mount msgvault archive (read-only) so container agent can search email/iMessage history
  if (
    fs.existsSync(msgvaultDir) &&
    fs.existsSync(path.join(msgvaultDir, 'msgvault.db'))
  ) {
    mounts.push({
      hostPath: msgvaultDir,
      containerPath: '/home/node/.msgvault',
      readonly: true,
    });
  }

  // Mount Sophie's taste profile docs read-write so the taste-aware-event-scout
  // skill can read taste.md / music-events.md / restaurants.md AND append
  // captures to additions.md. Skill instruction restricts writes to additions.md.
  if (
    fs.existsSync(tasteProfileDir) &&
    fs.existsSync(path.join(tasteProfileDir, 'taste.md'))
  ) {
    mounts.push({
      hostPath: tasteProfileDir,
      containerPath: '/workspace/extra/taste-profile',
      readonly: false,
    });
  }

  // Mount instacart-pp-cli state (config + history SQLite + cookies).
  // Read-write so the agent can both query history and run `add` (which
  // writes incremental purchase signal back into purchased_items).
  if (
    fs.existsSync(instacartHostDir) &&
    fs.existsSync(path.join(instacartHostDir, 'config.json'))
  ) {
    mounts.push({
      hostPath: instacartHostDir,
      containerPath: '/home/node/.config/instacart',
      readonly: false,
    });
  }

  // Mount amazon-pp-cli state (per-profile cookies + history DBs). Read-write
  // for the same reason as instacart: history-first add writes new purchase
  // signal back into the SQLite store.
  if (
    fs.existsSync(amazonHostDir) &&
    fs.existsSync(path.join(amazonHostDir, 'config.json'))
  ) {
    mounts.push({
      hostPath: amazonHostDir,
      containerPath: '/home/node/.config/amazon-pp-cli',
      readonly: false,
    });
  }

  // Mount pp-google-maps Playwright auth state read-only. Only the host
  // login script (container/skills/pp-google-maps/scripts/login.sh) writes
  // to this path; the in-container skill is forbidden from re-authing
  // (see Section 7 of SKILL.md), so a read-only mount keeps Playwright
  // from silently rewriting cookies during navigation and diverging from
  // the host-saved state.
  if (
    fs.existsSync(googleMapsHostDir) &&
    fs.existsSync(path.join(googleMapsHostDir, 'state.json'))
  ) {
    mounts.push({
      hostPath: googleMapsHostDir,
      containerPath: '/home/node/.config/google-maps',
      readonly: true,
    });
  }

  // Mount the maps-queue dir read-write. The skill writes save intents to
  // pending/ and reads completion outcomes from results/. Created on demand
  // by src/maps-queue.ts on host startup.
  fs.mkdirSync(mapsQueueHostDir, { recursive: true });
  mounts.push({
    hostPath: mapsQueueHostDir,
    containerPath: '/home/node/.config/maps-queue',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
): string[] {
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    '-m',
    '2G',
  ];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass optional service API keys for container skills (e.g. podcast synthesis)
  const serviceEnv = readEnvFile([
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    'ELEVENLABS_MODEL_ID',
    'ELEVENLABS_AGENT_ID',
    'ELEVENLABS_AGENT_PHONE_NUMBER_ID',
    'TELEGRAM_BOT_TOKEN',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
  ]);
  for (const [key, value] of Object.entries(serviceEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      args.push('-e', `RUN_UID=${hostUid}`);
      args.push('-e', `RUN_GID=${hostGid}`);
    } else {
      args.push('--user', `${hostUid}:${hostGid}`);
    }
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    args.push(
      ...bindMountArgs(mount.hostPath, mount.containerPath, mount.readonly),
    );
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, input.isMain);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
