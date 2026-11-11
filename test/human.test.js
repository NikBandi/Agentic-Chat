// Phase 3 human lock: human token (server, bus serve, CLI, dashboard), shell guard, deny rules.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { bashBlockReason } from '../src/hooks.js';
import { mergeSettings, DENY } from '../src/init.js';
import { writeHumanToken, readHumanToken, removeHumanToken } from '../src/human.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'bus.js');
let tmp, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-human-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const fresh = (p) => { const d = path.join(tmp, `${p}${++n}`); fs.mkdirSync(d); return d; };

function run(args, { env = {}, input = '', cwd = tmp } = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['BUS_AGENT', 'BUS_TEAM', 'BUS_PORT', 'BUS_AUTH', 'AGENTIC_CHAT_HOME']) if (!(k in env)) delete e[k];
  return new Promise((ok) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env: e, windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => ok({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.stdin.end(input);
  });
}
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

describe('human token on the server (BUS_AUTH=1)', () => {
  let srv, port, plain, plainPort;
  before(async () => {
    srv = createServer({ port: 0, auth: true });
    port = await srv.listen();
    plain = createServer({ port: 0 });
    plainPort = await plain.listen();
  });
  after(async () => { await srv.close(); await plain.close(); });
  const call = async (method, p, { human, agent, token, body, at = port } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (human !== undefined) headers['x-bus-human'] = human;
    if (agent) Object.assign(headers, { 'x-bus-agent': agent, 'x-bus-team': 'fe' });
    if (token) headers['x-bus-token'] = token;
    const r = await fetch(`http://127.0.0.1:${at}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };

  test('no agent name and no human token -> 401, for reads and human-only actions alike', async () => {
    for (const [m, p, body] of [['GET', '/api/state'], ['GET', '/api/task/list'], ['POST', '/api/approve', { id: 1 }],
      ['POST', '/api/reject', { id: 1, why: 'x' }], ['POST', '/api/auth/reset', { agent: 'a' }], ['POST', '/api/release', { of: 'a', all: true }]]) {
      const r = await call(m, p, { body });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.match(r.data.error, /^human token required/);
    }
    assert.equal((await call('GET', '/api/state', { human: 'wrong' })).status, 401);
  });
  test('with the human token the human acts normally (role checks still apply after)', async () => {
    const h = srv.humanToken;
    assert.equal((await call('GET', '/api/state', { human: h })).status, 200);
    assert.equal((await call('POST', '/api/approve', { human: h, body: { id: 99 } })).status, 404); // past auth: no such task
    const { data: { token } } = await call('POST', '/api/join', { agent: 'alice' });
    await call('POST', '/api/claim', { agent: 'alice', token, body: { paths: ['src/'] } });
    assert.equal((await call('POST', '/api/release', { human: h, body: { of: 'alice', all: true } })).data.released, 1);
  });
  test('naming yourself "you" is the human and needs the human token', async () => {
    assert.equal((await call('GET', '/api/state', { agent: 'you' })).status, 401);
    assert.equal((await call('GET', '/api/state', { agent: 'you', human: srv.humanToken })).status, 200);
  });
  test('an agent with a valid agent token is still not the human', async () => {
    const { data: { token } } = await call('POST', '/api/join', { agent: 'bob' });
    assert.equal((await call('POST', '/api/approve', { agent: 'bob', token, body: { id: 1 } })).status, 403);
    assert.equal((await call('POST', '/api/approve', { agent: 'bob', token, human: srv.humanToken, body: { id: 1 } })).status, 403);
  });
  test('dashboard page loads without a token; its event stream needs ?t=', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/events`)).status, 401);
    const ac = new AbortController();
    const ev = await fetch(`http://127.0.0.1:${port}/api/events?t=${encodeURIComponent(srv.humanToken)}`, { signal: ac.signal });
    assert.equal(ev.status, 200);
    assert.match(ev.headers.get('content-type'), /text\/event-stream/);
    ac.abort();
  });
  test('BUS_AUTH off: the human needs no token (existing setups keep working)', async () => {
    assert.equal((await call('GET', '/api/state', { at: plainPort })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${plainPort}/api/events`).then((r) => { r.body.cancel(); return r.status; })), 200);
  });
});

describe('bus serve writes the human token outside the repo and prints the dashboard link', () => {
  test('token file, dashboard URL, and human CLI commands reading the file', async () => {
    const home = fresh('home');
    const port = await freePort();
    const serve = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--data', path.join(fresh('data'), 'state.json')], {
      cwd: tmp, env: { ...process.env, BUS_AUTH: '1', AGENTIC_CHAT_HOME: home, BUS_AGENT: '' }, windowsHide: true,
    });
    try {
      const out = await new Promise((ok, fail) => {
        let s = '';
        const t = setTimeout(() => fail(new Error('serve did not start: ' + s)), 8000);
        serve.stdout.on('data', (d) => { s += d; if (/dashboard: /.test(s)) { clearTimeout(t); ok(s); } });
      });
      const token = fs.readFileSync(path.join(home, `${port}.human.token`), 'utf8').trim();
      assert.match(token, /^[\w-]{32}$/);
      assert.match(out, new RegExp(`^dashboard: http://127\\.0\\.0\\.1:${port}/#t=${token}$`, 'm'));
      const url = `http://127.0.0.1:${port}`;
      const ok = await run(['auth', 'reset', 'nobody'], { env: { BUS_URL: url, AGENTIC_CHAT_HOME: home } });
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(ok.stdout, 'nobody had no token');
      const denied = await run(['auth', 'reset', 'nobody'], { env: { BUS_URL: url, AGENTIC_CHAT_HOME: fresh('elsewhere') } });
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /^bus: human token required/);
    } finally { serve.kill(); }
  });
  test('removeHumanToken only deletes a file that still holds our token', () => {
    const home = fresh('home');
    process.env.AGENTIC_CHAT_HOME = home;
    try {
      writeHumanToken(1234, 'mine');
      removeHumanToken(1234, 'someone-else');
      assert.equal(readHumanToken(1234), 'mine');
      removeHumanToken(1234, 'mine');
      assert.equal(readHumanToken(1234), null);
    } finally { delete process.env.AGENTIC_CHAT_HOME; }
  });
});

describe('dashboard carries the human token', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'src', 'dashboard.html'), 'utf8');
  test('reads #t= once into sessionStorage, strips it from the URL, sends it on every request', () => {
    assert.match(html, /location\.hash/);
    assert.match(html, /sessionStorage\.setItem\('busHumanToken'/);
    assert.match(html, /history\.replaceState/);
    assert.match(html, /fetch\(path, \{[^}]*\.\.\.HUMAN_HDR/);
    assert.match(html, /fetch\('\/api\/state', \{ headers: HUMAN_HDR \}\)/);
    assert.match(html, /new EventSource\('\/api\/events' \+ \(HUMAN_TOKEN \? '\?t=' \+ encodeURIComponent\(HUMAN_TOKEN\)/);
    assert.ok(!/localStorage/.test(html), 'never persisted beyond the tab');
  });
});

describe('shell guard (PreToolUse on Bash|PowerShell)', () => {
  const blocked = [
    'bus approve 3', 'cd repo && bus reject 2 "nope"', 'node bin/bus.js approve 1', 'node "C:/x/bus.js" auth reset bob',
    'bus auth reset alice', 'curl -X POST http://127.0.0.1:4477/api/approve -d \'{"id":1}\'',
    'unset BUS_AGENT', 'unset FOO BUS_AGENT', 'BUS_AGENT=lead bus task merged 1', 'export BUS_AGENT=lead',
    'env -u BUS_AGENT bus send hi', 'env -i sh -c "bus approve 1"', 'env --ignore-environment node x',
    '$env:BUS_AGENT = "lead"', 'Remove-Item env:BUS_AGENT', 'set BUS_AGENT=lead',
    'cat ~/.agentic-chat/4477.human.token', 'type %USERPROFILE%\\.agentic-chat\\4477.human.token',
  ];
  const allowed = [
    'bus task done 1 "summary"', 'bus send @lead "ready for you to approve #3"', 'bus read', 'npm test',
    'echo $BUS_AGENT', '[ "$BUS_AGENT" = lead ] && echo yes', '[ $BUS_AGENT == lead ]', 'printenv BUS_AGENT',
    'git log --author=bus', 'bus claims --mine', 'grep -r authors .',
  ];
  for (const c of blocked) test(`blocks: ${c}`, () => assert.ok(bashBlockReason(c), c));
  for (const c of allowed) test(`allows: ${c}`, () => assert.equal(bashBlockReason(c), null));

  test('hook: exit 2 with one line for agents; the human session and harmless commands pass silently', async () => {
    const input = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    const agent = { BUS_AGENT: 'bob', BUS_TEAM: 'be' };
    const r = await run(['hook', 'bash'], { env: agent, input: input('bus approve 4') });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, "bus: blocked — this command approve/reject/auth are human-only bus commands. Agents can't act as the human; ask @you.");
    assert.equal(r.stderr.split('\n').length, 1);
    const ps = await run(['hook', 'bash'], { env: agent, input: JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: '$env:BUS_AGENT="lead"' } }) });
    assert.equal(ps.code, 2);
    for (const x of [await run(['hook', 'bash'], { env: {}, input: input('bus approve 4') }), await run(['hook', 'bash'], { env: agent, input: input('npm test') })]) {
      assert.equal(x.code, 0);
      assert.equal(x.stdout + x.stderr, '');
    }
  });
});

describe('bus init deny rules', () => {
  test("agents can't read or edit ~/.agentic-chat; existing rules kept; idempotent", () => {
    const s = { permissions: { deny: ['Bash(rm -rf *)'] } };
    assert.equal(mergeSettings(s), true);
    assert.deepEqual(s.permissions.deny, ['Bash(rm -rf *)', ...DENY]);
    assert.ok(DENY.includes('Read(~/.agentic-chat/**)'));
    assert.equal(mergeSettings(s), false);
    assert.equal(s.permissions.deny.length, 1 + DENY.length);
  });
});
