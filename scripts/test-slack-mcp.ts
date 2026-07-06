// One-shot: drive a real telegram_main agent container to exercise the Slack MCP.
// Fresh session (no sessionId) so it doesn't touch the live session row.
import { initDatabase, getRegisteredGroup } from '../src/db.js';
import { runContainerAgent } from '../src/container-runner.js';

initDatabase();
const group = getRegisteredGroup('tg:8535290004');
if (!group) throw new Error('telegram_main group not found');

const prompt = [
  'WIRING TEST. Use ONLY the Slack MCP server to do this — do not use any other tool.',
  'Call mcp__Slack__channels_list (public channels, limit 5) and then',
  'mcp__Slack__conversations_history for #general to get the single most recent message.',
  'Report back: (1) the channel names you got, (2) the most recent #general message text + author.',
  'If the Slack tools are not available, say exactly: "SLACK MCP NOT AVAILABLE".',
].join(' ');

const out = await runContainerAgent(
  group,
  {
    prompt,
    groupFolder: group.folder,
    chatJid: 'tg:8535290004',
    isMain: true,
    assistantName: 'NanoClaw',
  },
  () => {},
);

console.log('\n=====SLACK TEST RESULT=====');
console.log('status:', out.status);
if (out.error) console.log('error:', out.error);
console.log('result:\n', out.result);
console.log('=====END=====');
process.exit(out.status === 'success' ? 0 : 1);
