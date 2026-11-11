import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeSettings, mergeClaudeMd, init, AGENT_RULES } from '../src/init.js';
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
    assert.equal(s.hooks.PostToolUse[0].matcher, '*');
    assert.match(s.hooks.PostToolUse[0].hooks[0].command, / hook post$/);
  });

  test('mergeClaudeMd appends once and replaces between markers', () => {
    const once = mergeClaudeMd('# Proj\n\nnotes\n');
    assert.match(once, /^# Proj\n\nnotes\n\n<!-- agent-bus -->/);
    assert.equal(mergeClaudeMd(once), once);
    const stale = '# P\n<!-- agent-bus -->\nold\n<!-- /agent-bus -->\ntail\n';
    const fresh = mergeClaudeMd(stale);
    assert.ok(!fresh.includes('\nold\n') && fresh.endsWith('tail\n'));
  });

  test('agent rules: commit before done, lead merges the sha plainly, block stays ~10 lines', () => {
    assert.match(AGENT_RULES, /^- Commit your work on your branch before bus task done\.$/m);
    assert.match(AGENT_RULES, /^- Lead: Merge with plain `git merge <sha>` — no squash or rebase\.$/m);
    assert.ok(AGENT_RULES.split('\n').length <= 12, 'rules block (incl. markers) must stay short');
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
  const run = (env, input, sub = 'pre') => new Promise((ok) => {
    const p = spawn(process.execPath, [BIN, 'hook', sub], {
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
  test('allows owner, free files and no identity — silently (bus-down warning: test/guard.test.js)', async () => {
    for (const r of await Promise.all([
      run({ BUS_AGENT: 'alice', BUS_TEAM: 'fe' }, edit(path.join(repo, 'src', 'api', 'u.ts'))),
      run({ BUS_AGENT: 'bob', BUS_TEAM: 'be' }, edit(path.join(repo, 'README.md'))),
      run({}, edit(path.join(repo, 'src', 'api', 'u.ts'))),
    ])) { assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, ''); }
  });

  describe('PostToolUse notice', () => {
    const post = (env) => run(env, { tool_name: 'Bash', tool_input: { command: 'ls' } }, 'post');
    const carol = { BUS_AGENT: 'carol', BUS_TEAM: 'qa' };

    test('silent when nothing is waiting or without identity', async () => {
      srv.bus.touch('carol', 'qa');
      srv.bus.read('carol');
      for (const r of await Promise.all([post(carol), post({})])) {
        assert.equal(r.status, 0);
        assert.equal(r.stdout + r.stderr, '');
      }
    });

    test('one additionalContext line per new batch, then silent until something newer', async () => {
      srv.bus.send('alice', '@carol', 'hi');
      srv.bus.send('alice', '@qa', 'team ping');
      const first = await post(carol);
      const out = JSON.parse(first.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.match(out.hookSpecificOutput.additionalContext, /^bus: 2 new for you \(from @alice\) — run: bus read$/);
      assert.equal((await post(carol)).stdout, ''); // ignored notice is not repeated
      srv.bus.send('alice', '@carol', 'again');
      assert.match(JSON.parse((await post(carol)).stdout).hookSpecificOutput.additionalContext, /3 new/);
      srv.bus.read('carol');
      assert.equal((await post(carol)).stdout, '');
    });
  });
});
