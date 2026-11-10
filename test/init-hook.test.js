import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeSettings, mergeClaudeMd, init } from '../src/init.js';
import { createServer } from '../src/server.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');

describe('bus init', () => {
  test('mergeSettings keeps other settings and is idempotent', () => {
    const s = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } };
    assert.equal(mergeSettings(s), true);
    assert.equal(mergeSettings(s), false);
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.PreToolUse[1].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  });

  test('mergeClaudeMd appends once and replaces between markers', () => {
    const once = mergeClaudeMd('# Proj\n\nnotes\n');
    assert.match(once, /^# Proj\n\nnotes\n\n<!-- agent-bus -->/);
    assert.equal(mergeClaudeMd(once), once);
    const stale = '# P\n<!-- agent-bus -->\nold\n<!-- /agent-bus -->\ntail\n';
    const fresh = mergeClaudeMd(stale);
    assert.ok(!fresh.includes('\nold\n') && fresh.endsWith('tail\n'));
  });

  test('init writes files and refuses invalid settings JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-init-'));
    try {
      init(dir);
      assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse);
      assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /agent-bus/);
      fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{oops');
      assert.throws(() => init(dir), /not valid JSON/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('PreToolUse edit guard', () => {
  let srv, port, repo;
  before(async () => {
    srv = createServer({ port: 0 });
    port = await srv.listen();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-hook-'));
    fs.mkdirSync(path.join(repo, '.git'));
    srv.bus.touch('alice', 'fe');
    srv.bus.claim('alice', ['src/api/']);
  });
  after(async () => { await srv.close(); fs.rmSync(repo, { recursive: true, force: true }); });

  // Async spawn: spawnSync would block this process's event loop, and with it the in-process server.
  const run = (env, input) => new Promise((ok) => {
    const p = spawn(process.execPath, [BIN, 'hook', 'pre'], {
      env: { ...process.env, BUS_AGENT: '', BUS_TEAM: '', BUS_URL: `http://127.0.0.1:${port}`, ...env },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => ok({ status, stdout, stderr }));
    p.stdin.end(JSON.stringify(input));
  });
  const edit = (file) => ({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: file } });

  test('blocks another agent with exit 2 and names the owner', async () => {
    const r = await run({ BUS_AGENT: 'bob', BUS_TEAM: 'be' }, edit(path.join(repo, 'src', 'api', 'u.ts')));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /claimed by alice/);
  });
  test('relative path and notebook_path are resolved too', async () => {
    assert.equal((await run({ BUS_AGENT: 'bob', BUS_TEAM: 'be' }, edit(path.join('src', 'api', 'u.ts')))).status, 2);
    const nb = { cwd: repo, tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'src', 'api', 'n.ipynb') } };
    assert.equal((await run({ BUS_AGENT: 'bob', BUS_TEAM: 'be' }, nb)).status, 2);
  });
  test('allows owner, free files, no identity, and a down server — silently', async () => {
    for (const r of await Promise.all([
      run({ BUS_AGENT: 'alice', BUS_TEAM: 'fe' }, edit(path.join(repo, 'src', 'api', 'u.ts'))),
      run({ BUS_AGENT: 'bob', BUS_TEAM: 'be' }, edit(path.join(repo, 'README.md'))),
      run({}, edit(path.join(repo, 'src', 'api', 'u.ts'))),
      run({ BUS_AGENT: 'bob', BUS_TEAM: 'be', BUS_URL: 'http://127.0.0.1:1' }, edit(path.join(repo, 'src', 'api', 'u.ts'))),
    ])) { assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, ''); }
  });
});
