import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeSettings, stripClaudeMd, init, rulesFor } from '../src/init.js';
import { createServer } from '../src/server.js';
import { transcriptUsage } from '../src/hooks.js';
import { fmtUsage } from '../src/bus.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');

describe('bus init', () => {
  test('mergeSettings keeps other settings and is idempotent', () => {
    const s = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } };
    assert.equal(mergeSettings(s), true);
    assert.equal(mergeSettings(s), false);
    assert.deepEqual(s.permissions.allow, ['Bash(ls)']);
    assert.equal(s.hooks.PreToolUse.length, 3);
    assert.equal(s.hooks.PreToolUse[1].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
    assert.equal(s.hooks.PreToolUse[2].matcher, 'Bash|PowerShell');
    assert.match(s.hooks.PreToolUse[2].hooks[0].command, / hook bash$/);
    assert.equal(s.hooks.PostToolUse[0].matcher, '*');
    assert.match(s.hooks.PostToolUse[0].hooks[0].command, / hook post$/);
  });

  test('stripClaudeMd removes an old agent-rules block and nothing else', () => {
    assert.equal(stripClaudeMd('# P\n\n<!-- agent-bus -->\nold\n<!-- /agent-bus -->\n\ntail\n'), '# P\n\ntail\n');
    assert.equal(stripClaudeMd('# P\n'), '# P\n');
  });

  test('rules: only for agents; workers get no lead line; leads do; stays short', () => {
    assert.equal(rulesFor({}), '');
    const w = rulesFor({ BUS_AGENT: 'fe-1', BUS_TEAM: 'frontend' });
    assert.match(w, /^Agent bus: you are fe-1 on team frontend\./);
    assert.match(w, /^- Commit your work on your branch before bus task done\./m);
    assert.ok(!/^- Leads:/m.test(w));
    const l = rulesFor({ BUS_AGENT: 'fe-lead', BUS_TEAM: 'frontend', BUS_ROLE: 'lead' });
    assert.match(l, /^- Leads: .*Merge with plain `git merge <sha>` — no squash or rebase\.$/m);
    assert.ok(l.split('\n').length <= 10, 'rules must stay short');
  });

  test('init writes settings (incl. SessionStart/Stop hooks), never adds rules to CLAUDE.md, refuses invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-init-'));
    try {
      init(dir);
      const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
      assert.ok(s.hooks.PreToolUse && s.hooks.SessionStart && s.hooks.Stop);
      assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
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

    test('up to 2 short messages are delivered in the notice itself and count as read', async () => {
      srv.bus.send('alice', '@carol', 'hi');
      srv.bus.send('alice', '@qa', 'team ping');
      const out = JSON.parse((await post(carol)).stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.match(out.hookSpecificOutput.additionalContext, /^bus: \d+ alice>@carol: hi\nbus: \d+ alice>#qa: team ping$/);
      assert.equal(srv.bus.pending('carol'), 0);
      assert.equal((await post(carol)).stdout, '');
    });

    test('bigger batches: one "run bus read" line per new batch, then silent until something newer', async () => {
      for (const t of ['a', 'b', 'c']) srv.bus.send('alice', '@carol', t);
      assert.match(JSON.parse((await post(carol)).stdout).hookSpecificOutput.additionalContext, /^bus: 3 new for you \(from @alice\) — run: bus read$/);
      assert.equal((await post(carol)).stdout, ''); // ignored notice is not repeated
      srv.bus.send('alice', '@carol', 'again');
      assert.match(JSON.parse((await post(carol)).stdout).hookSpecificOutput.additionalContext, /4 new/);
      srv.bus.read('carol');
      srv.bus.send('alice', '@carol', 'x'.repeat(201)); // one long message: pointer, not inline
      assert.match(JSON.parse((await post(carol)).stdout).hookSpecificOutput.additionalContext, /1 new .* run: bus read/);
    });
  });

  describe('SessionStart rules', () => {
    test('agents get their role\'s rules; the human and spawned workers get nothing', async () => {
      const w = JSON.parse((await run({ BUS_AGENT: 'fe-1', BUS_TEAM: 'frontend' }, { source: 'startup' }, 'start')).stdout);
      assert.equal(w.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(w.hookSpecificOutput.additionalContext, /^Agent bus: you are fe-1 on team frontend\./);
      const l = JSON.parse((await run({ BUS_AGENT: 'fe-lead', BUS_TEAM: 'frontend', BUS_ROLE: 'lead' }, {}, 'start')).stdout);
      assert.match(l.hookSpecificOutput.additionalContext, /^- Leads:/m);
      for (const env of [{}, { BUS_AGENT: 'frontend-1', BUS_TEAM: 'frontend', BUS_SPAWNED: '1' }]) {
        const r = await run(env, {}, 'start');
        assert.equal(r.status, 0);
        assert.equal(r.stdout + r.stderr, '');
      }
    });
  });

  describe('Stop hook: token usage', () => {
    const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, usage: u } });
    test('transcriptUsage dedupes by message id and includes subagent transcripts', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tx-'));
      try {
        const f = path.join(dir, 'sess.jsonl');
        const u1 = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };
        fs.writeFileSync(f, [line('m1', u1), line('m1', u1), '{"type":"user"}', 'not json', line('m2', { input_tokens: 1, output_tokens: 5 })].join('\n'));
        fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-a.jsonl'), line('m3', { input_tokens: 4, output_tokens: 1 }));
        assert.deepEqual(transcriptUsage(f, 'sess'), { input: 7, output: 16, cacheRead: 100, cacheWrite: 50 });
        assert.equal(transcriptUsage(path.join(dir, 'missing.jsonl')), null);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('the hook posts cumulative totals; the bus adds only the increase, to the agent and its task', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tx-'));
      try {
        srv.bus.touch('dora', 'qa');
        const t = srv.tasks.add('you', { title: 'measure', check: 'node -v', assignee: 'dora' });
        srv.tasks.take('dora', t.id);
        const f = path.join(dir, 's1.jsonl');
        const dora = { BUS_AGENT: 'dora', BUS_TEAM: 'qa' };
        fs.writeFileSync(f, line('m1', { input_tokens: 10, output_tokens: 20 }));
        let r = await run(dora, { session_id: 's1', transcript_path: f }, 'stop');
        assert.equal(r.status, 0);
        assert.equal(r.stdout + r.stderr, ''); // silent: zero tokens
        fs.appendFileSync(f, '\n' + line('m2', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 85 }));
        r = await run(dora, { session_id: 's1', transcript_path: f }, 'stop');
        assert.deepEqual(srv.bus.s.agents.dora.usage, { input: 15, output: 21, cacheRead: 85, cacheWrite: 0 });
        assert.deepEqual(t.usage, srv.bus.s.agents.dora.usage);
        assert.equal(fmtUsage(t.usage), 'tokens: 100 in (85% cached), 21 out');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
