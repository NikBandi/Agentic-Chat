// Phase 2 enforcement: git pre-commit claim guard, bus-down warning, optional per-agent tokens (BUS_AUTH).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { init, installGitHook, CHAINED, GIT_HOOK_MARK } from '../src/init.js';
import { DOWN_MSG } from '../src/hooks.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
const skip = !hasGit && 'git not installed';
const GIT_CFG = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const g = (cwd, ...args) => execFileSync('git', [...GIT_CFG, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-guard-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const fresh = (p = 'd') => { const d = path.join(tmp, `${p}${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
function repo() {
  const d = fresh('r');
  g(d, 'init', '-q'); g(d, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a'); g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  return d;
}

/** Async spawn (the server lives in this process). env: extra vars; BUS_* identity cleared unless given. */
function run(cmd, args, { cwd = tmp, env = {}, input } = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['BUS_AGENT', 'BUS_TEAM', 'BUS_PORT', 'BUS_AUTH']) if (!(k in env)) delete e[k];
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd, env: e, windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => ok({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.stdin.end(input ?? '');
  });
}
const bus = (args, opts) => run(process.execPath, [BIN, ...args], opts);
const commit = (cwd, env, msg = 'c') => run('git', [...GIT_CFG, 'commit', '-q', '-m', msg], { cwd, env });
/** Each child gets its own temp dir, so bus-down markers never leak between tests. */
const tmpEnv = (dir = fresh('t')) => ({ TMPDIR: dir, TEMP: dir, TMP: dir });

describe('bus init installs a git pre-commit hook', { skip }, () => {
  test('installs once, is idempotent, and skips non-repos', () => {
    const r = repo();
    assert.match(installGitHook(r), /^installed pre-commit hook in /);
    const hook = path.join(r, '.git', 'hooks', 'pre-commit');
    assert.match(fs.readFileSync(hook, 'utf8'), new RegExp(GIT_HOOK_MARK));
    assert.match(installGitHook(r), /already current/);
    assert.match(installGitHook(fresh('plain')), /^not a git repo — skipped/);
    assert.ok(init(r).some((l) => /pre-commit hook/.test(l)));
  });
  test('keeps and chains a foreign hook instead of overwriting it', async () => {
    const r = repo();
    const hooks = path.join(r, '.git', 'hooks');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho previous-hook-ran >&2\nexit 1\n', { mode: 0o755 });
    assert.match(installGitHook(r), new RegExp(`chains to your previous hook, now ${CHAINED}`));
    assert.match(fs.readFileSync(path.join(hooks, CHAINED), 'utf8'), /previous-hook-ran/);
    assert.match(installGitHook(r), /already current/);
    fs.writeFileSync(path.join(r, 'b.txt'), 'b'); g(r, 'add', 'b.txt');
    const blocked = await commit(r, {}); // no BUS_AGENT: only the chained hook decides
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /previous-hook-ran/);
    fs.writeFileSync(path.join(hooks, CHAINED), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal((await commit(r, {})).code, 0);
  });
  test('a worktree shares the main repo hooks dir', () => {
    const r = repo();
    const wt = path.join(tmp, `wt${++n}`);
    g(r, 'worktree', 'add', '-q', '-b', 'feat', wt);
    installGitHook(wt);
    assert.ok(fs.existsSync(path.join(r, '.git', 'hooks', 'pre-commit')));
  });
});

describe('pre-commit claim guard (real git commits)', { skip }, () => {
  let srv, port, r, url;
  before(async () => {
    srv = createServer({ port: 0, repoDir: tmp });
    port = await srv.listen();
    url = `http://127.0.0.1:${port}`;
    r = repo();
    installGitHook(r);
    srv.bus.touch('alice', 'fe');
    srv.bus.claim('alice', ['src/api/']);
    srv.bus.hotAdd('lead', ['package.json']);
  });
  after(() => srv.close());
  const as = (agent, team = 'fe') => ({ BUS_AGENT: agent, BUS_TEAM: team, BUS_URL: url, ...tmpEnv() });
  const stage = (file, text = String(++n)) => {
    fs.mkdirSync(path.dirname(path.join(r, file)), { recursive: true });
    fs.writeFileSync(path.join(r, file), text); g(r, 'add', file);
  };
  const reset = () => { try { g(r, 'reset', '-q'); } catch { /* nothing staged */ } };

  test("blocks another agent's claimed file with one line; the owner may commit it", async () => {
    stage('src/api/u.js');
    const c = await commit(r, as('bob', 'be'));
    assert.notEqual(c.code, 0);
    assert.equal(c.stderr, 'bus: commit blocked — src/api/u.js is claimed by alice; unstage it (git restore --staged src/api/u.js) and ask @alice');
    assert.equal(g(r, 'diff', '--cached', '--name-only'), 'src/api/u.js'); // still staged, nothing committed
    assert.equal((await commit(r, as('alice'))).code, 0);
  });
  test('names the first blocked file and counts the rest', async () => {
    stage('src/api/x.js'); stage('src/api/y.js');
    const c = await commit(r, as('bob', 'be'));
    assert.match(c.stderr, /^bus: commit blocked — src\/api\/x\.js is claimed by alice \(\+1 more\);/);
    reset();
  });
  test('hot files: blocked for workers, allowed for the lead', async () => {
    stage('package.json');
    const c = await commit(r, as('bob', 'be'));
    assert.match(c.stderr, /^bus: commit blocked — package\.json is a hot file owned by lead; unstage it and ask: bus request package\.json/);
    assert.equal((await commit(r, as('lead', 'lead'))).code, 0);
  });
  test('allowed: free files, no BUS_AGENT (the human), concluding a merge', async () => {
    stage('docs/free.md');
    assert.equal((await commit(r, as('bob', 'be'))).code, 0);
    stage('src/api/human.js');
    assert.equal((await commit(r, { BUS_URL: url })).code, 0);
    stage('src/api/merge.js');
    fs.writeFileSync(path.join(r, '.git', 'MERGE_HEAD'), g(r, 'rev-parse', 'HEAD') + '\n');
    try {
      const h = await bus(['hook', 'commit'], { cwd: r, env: as('bob', 'be') });
      assert.equal(h.code, 0, h.stderr);
    } finally { fs.rmSync(path.join(r, '.git', 'MERGE_HEAD')); reset(); }
  });
  test('bus down: commit allowed, warning printed once', async () => {
    const env = { ...as('bob', 'be'), BUS_URL: 'http://127.0.0.1:1' };
    stage('src/api/down1.js');
    const first = await commit(r, env);
    assert.equal(first.code, 0);
    assert.equal(first.stderr, DOWN_MSG);
    stage('src/api/down2.js');
    const second = await commit(r, env);
    assert.equal(second.code, 0);
    assert.equal(second.stderr, '');
  });
});

describe('bus-down warning from the Claude Code hooks', () => {
  let srv, port;
  before(async () => { srv = createServer({ port: 0 }); port = await srv.listen(); });
  after(() => srv.close());
  const edit = { cwd: tmp, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'x.txt') } };
  const hook = (sub, env, input = edit) => bus(['hook', sub], { env, input: JSON.stringify(input) });

  test('PreToolUse warns once (context + user), then stays silent; edits are allowed', async () => {
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    const env = { BUS_AGENT: 'bob', BUS_TEAM: 'be', BUS_URL: 'http://127.0.0.1:1', ...tmpEnv() };
    const first = await hook('pre', env);
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: DOWN_MSG }, systemMessage: DOWN_MSG });
    const again = await hook('pre', env);
    assert.equal(again.code, 0);
    assert.equal(again.stdout + again.stderr, '');
    assert.equal((await hook('post', env)).stdout, ''); // shared marker: PostToolUse doesn't repeat it
  });
  test('PostToolUse warns too; keyed per agent and per port; silent without BUS_AGENT', async () => {
    const dirs = tmpEnv();
    const out = async (env) => (await hook('post', { ...dirs, ...env })).stdout;
    const down = { BUS_TEAM: 'be', BUS_URL: 'http://127.0.0.1:1' };
    assert.equal(JSON.parse(await out({ ...down, BUS_AGENT: 'carl' })).hookSpecificOutput.additionalContext, DOWN_MSG);
    assert.equal(await out({ ...down, BUS_AGENT: 'carl' }), '');
    assert.match(await out({ ...down, BUS_AGENT: 'dana' }), /unreachable/);
    assert.match(await out({ ...down, BUS_AGENT: 'carl', BUS_URL: 'http://127.0.0.1:2' }), /unreachable/);
    assert.equal(await out({ BUS_URL: 'http://127.0.0.1:1' }), '');
  });
  test('reaching the bus again clears the marker, so the next outage warns again', async () => {
    const dir = fresh('t');
    const marker = path.join(dir, `agent-bus-down-erin-${port}`);
    fs.writeFileSync(marker, '1');
    const env = { BUS_AGENT: 'erin', BUS_TEAM: 'qa', BUS_URL: `http://127.0.0.1:${port}`, ...tmpEnv(dir) };
    const r = await hook('post', env);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('BUS_AUTH per-agent tokens', () => {
  let srv, port, plain, plainPort;
  before(async () => {
    srv = createServer({ port: 0, auth: true });
    port = await srv.listen();
    plain = createServer({ port: 0, auth: false });
    plainPort = await plain.listen();
  });
  after(async () => { await srv.close(); await plain.close(); });
  async function api(method, p, { agent, token, body, at = port } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (agent) Object.assign(headers, { 'x-bus-agent': agent, 'x-bus-team': 'fe' });
    if (token) headers['x-bus-token'] = token;
    const res = await fetch(`http://127.0.0.1:${at}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  }

  test('off by default: join issues no token and nothing is required', async () => {
    const j = await api('POST', '/api/join', { agent: 'zed', at: plainPort });
    assert.equal(j.status, 200);
    assert.equal(j.data.token, undefined);
    assert.equal((await api('GET', '/api/claims', { agent: 'zed', at: plainPort })).status, 200);
  });
  test('join issues a token once; later requests need it; the human is unaffected', async () => {
    const j = await api('POST', '/api/join', { agent: 'alice' });
    assert.equal(j.status, 200);
    const token = j.data.token;
    assert.match(token, /^[\w-]{32}$/);
    assert.notEqual(srv.bus.s.tokens.alice, token, 'stored hashed');
    assert.equal((await api('GET', '/api/claims', { agent: 'alice' })).status, 401);
    assert.equal((await api('GET', '/api/claims', { agent: 'alice', token: 'nope' })).status, 401);
    assert.equal((await api('GET', '/api/claims', { agent: 'alice', token })).status, 200);
    const rejoin = await api('POST', '/api/join', { agent: 'alice' });
    assert.equal(rejoin.status, 401, 'a token-less re-join cannot take over the name');
    const ok = await api('POST', '/api/join', { agent: 'alice', token });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.token, undefined, 'no new token on re-join');
    assert.equal((await api('GET', '/api/claims')).status, 200);
  });
  test('unknown agents must join first and are not registered by other calls', async () => {
    const r = await api('POST', '/api/send', { agent: 'mallory', body: { to: '#general', text: 'hi' } });
    assert.equal(r.status, 401);
    assert.match(r.data.error, /run bus join/);
    assert.equal(srv.bus.s.agents.mallory, undefined);
  });
  test('tokens never leave the server through /api/state', async () => {
    const s = await api('GET', '/api/state');
    assert.equal(s.data.tokens, undefined);
    assert.ok(!JSON.stringify(s.data).includes(srv.bus.s.tokens.alice));
  });
  test('only the human resets a token; the agent can then join again', async () => {
    const { data: { token } } = await api('POST', '/api/join', { agent: 'bob' });
    assert.equal((await api('POST', '/api/auth/reset', { agent: 'bob', token, body: { agent: 'bob' } })).status, 403);
    assert.deepEqual((await api('POST', '/api/auth/reset', { body: { agent: 'bob' } })).data, { agent: 'bob', reset: true });
    const again = await api('POST', '/api/join', { agent: 'bob' });
    assert.equal(again.status, 200);
    assert.ok(again.data.token && again.data.token !== token);
  });

  test('CLI: join stores a git-ignored token in the worktree, later commands send it', { skip }, async () => {
    const r = repo();
    const sub = path.join(r, 'src', 'deep'); fs.mkdirSync(sub, { recursive: true });
    const env = { BUS_AGENT: 'carol', BUS_TEAM: 'qa', BUS_URL: `http://127.0.0.1:${port}` };
    const j = await bus(['join'], { cwd: r, env });
    assert.equal(j.code, 0, j.stderr);
    assert.equal(j.stdout, 'joined as carol (team qa)');
    const file = path.join(r, '.bus', 'agents', 'carol.token');
    assert.match(fs.readFileSync(file, 'utf8'), /^[\w-]{32}\n$/);
    assert.equal(fs.readFileSync(path.join(r, '.bus', '.gitignore'), 'utf8'), '*\n');
    assert.equal(g(r, 'status', '--porcelain'), '', 'token never shows up as a change');
    const c = await bus(['claims'], { cwd: sub, env }); // token found by walking up from a subdirectory
    assert.equal(c.code, 0, c.stderr);
    fs.rmSync(file);
    const denied = await bus(['claims'], { cwd: sub, env });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /^bus: bad or missing token for carol — .*bus auth reset carol$/);
    const reset = await bus(['auth', 'reset', 'carol'], { cwd: r, env: { BUS_URL: `http://127.0.0.1:${port}` } });
    assert.equal(reset.stdout, 'token for carol reset — it can bus join again');
  });
  test('the edit guard blocks an agent whose token is missing', async () => {
    srv.bus.claim('alice', ['src/']);
    const d = fresh('w'); fs.mkdirSync(path.join(d, '.git'));
    const env = { BUS_AGENT: 'alice', BUS_TEAM: 'fe', BUS_URL: `http://127.0.0.1:${port}`, ...tmpEnv() };
    const r = await bus(['hook', 'pre'], { cwd: d, env, input: JSON.stringify({ cwd: d, tool_name: 'Edit', tool_input: { file_path: path.join(d, 'src', 'a.js') } }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^bus: bad or missing token for alice/);
  });
});
