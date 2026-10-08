import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

let home: string;
let savedHome: string | undefined;
let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
  containerConfig: {
    additionalMounts: [
      { hostPath: '~/vault', containerPath: 'vault', readonly: false },
    ],
  },
};

const OTHER: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

function obsidian(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
) {
  return processTaskIpc(
    { type: 'obsidian_write', ...data } as Parameters<typeof processTaskIpc>[0],
    sourceGroup,
    isMain,
    deps,
  );
}

beforeEach(() => {
  _initTestDatabase();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, 'vault', 'Notes'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'vault', 'Notes', 'todo.md'),
    '- [ ] buy milk\n',
  );
  fs.writeFileSync(path.join(home, 'outside.md'), 'untouched\n');
  groups = { 'tg:1': MAIN, 'other@g.us': OTHER };
  setRegisteredGroup('tg:1', MAIN);
  setRegisteredGroup('other@g.us', OTHER);
  deps = {
    sendMessage: async () => {},
    sendImage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('obsidian_write', () => {
  it('expands ~ in the vault mount hostPath', async () => {
    await obsidian(
      {
        action: 'add_line',
        dir: 'Notes',
        file: 'todo.md',
        line: '- [ ] call mom',
        groupFolder: 'telegram_main',
      },
      'telegram_main',
      true,
    );
    expect(
      fs.readFileSync(path.join(home, 'vault', 'Notes', 'todo.md'), 'utf-8'),
    ).toContain('call mom');
  });

  it('uses the verified sourceGroup, not the groupFolder claimed in the payload', async () => {
    await obsidian(
      {
        action: 'add_line',
        dir: 'Notes',
        file: 'todo.md',
        line: '- [ ] spoofed',
        groupFolder: 'telegram_main',
      },
      'other-group',
      false,
    );
    expect(
      fs.readFileSync(path.join(home, 'vault', 'Notes', 'todo.md'), 'utf-8'),
    ).not.toContain('spoofed');
  });

  it('blocks path traversal in file for edit actions', async () => {
    await obsidian(
      {
        action: 'add_line',
        dir: 'Notes',
        file: '../../outside.md',
        line: 'pwned',
        groupFolder: 'telegram_main',
      },
      'telegram_main',
      true,
    );
    expect(fs.readFileSync(path.join(home, 'outside.md'), 'utf-8')).toBe(
      'untouched\n',
    );
  });

  it('create_file works under a ~ vault path', async () => {
    await obsidian(
      {
        action: 'create_file',
        dir: 'Notes',
        file: 'new.md',
        content: '# hi',
        groupFolder: 'telegram_main',
      },
      'telegram_main',
      true,
    );
    expect(fs.existsSync(path.join(home, 'vault', 'Notes', 'new.md'))).toBe(
      true,
    );
  });
});
