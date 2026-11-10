import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-srv-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
const newFile = () => path.join(tmp, `state-${++n}.json`);

async function start(dataFile = newFile()) {
  const srv = createServer({ dataFile, port: 0 });
  const port = await srv.listen();
  const call = async (method, p, { agent, team, body } = {}) => {
    const headers = {};
    if (agent) headers['x-bus-agent'] = encodeURIComponent(agent);
    if (team) headers['x-bus-team'] = encodeURIComponent(team);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { srv, port, call, dataFile };
}

async function withServer(fn, dataFile) {
  const ctx = await start(dataFile);
  try { await fn(ctx); } finally { await ctx.srv.close(); }
}

describe('server', () => {
  test('send/read round trip', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const s = await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '@bob', text: 'hello' } });
    assert.equal(s.status, 200);
    assert.equal(s.data.message.from, 'alice');
    const r = await call('POST', '/api/read', { agent: 'bob', team: 'fe' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.messages.map((m) => m.text), ['hello']);
    const again = await call('POST', '/api/read', { agent: 'bob', team: 'fe' });
    assert.deepEqual(again.data, { messages: [], skipped: 0 });
  }));

  test('pending and show', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const { data } = await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '@bob', text: 'x' } });
    assert.equal((await call('GET', '/api/pending', { agent: 'bob' })).data.pending, 1);
    assert.equal((await call('GET', `/api/show?id=${data.message.id}`, { agent: 'bob' })).data.message.text, 'x');
    assert.equal((await call('GET', '/api/show?id=999', { agent: 'bob' })).status, 404);
  }));

  test('human (no header) can send but /api/read returns 400', () => withServer(async ({ call, srv }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const s = await call('POST', '/api/send', { body: { to: '@bob', text: 'from human' } });
    assert.equal(s.status, 200);
    assert.equal(s.data.message.from, 'you');
    const r = await call('POST', '/api/read');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /BUS_AGENT/);
    assert.equal(srv.bus.pending('bob'), 1);
  }));

  test('new agent without team header is rejected', () => withServer(async ({ call }) => {
    const r = await call('POST', '/api/read', { agent: 'ghost' });
    assert.equal(r.status, 400);
  }));

  test('errors: unknown route 404, bad target 404, bad JSON 400', () => withServer(async ({ call, port }) => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('POST', '/api/send', { agent: 'a', team: 't', body: { to: '@zzz', text: 'x' } })).status, 404);
    const res = await fetch(`http://127.0.0.1:${port}/api/send`, { method: 'POST', body: '{nope' });
    assert.equal(res.status, 400);
    await res.json();
  }));

  test('claim / check / release over HTTP', () => withServer(async ({ call }) => {
    const a = { agent: 'alice', team: 'fe' }, b = { agent: 'bob', team: 'be' };
    assert.equal((await call('POST', '/api/claim', { ...a, body: { paths: ['src/api/'], why: 'w' } })).data.ok, true);
    const bad = await call('POST', '/api/claim', { ...b, body: { paths: ['src/api/x.ts'] } });
    assert.equal(bad.data.ok, false);
    assert.equal(bad.data.conflicts[0].owner, 'alice');
    assert.equal((await call('GET', '/api/check?path=src/api/x.ts', b)).data.free, false);
    assert.equal((await call('GET', '/api/claims?mine=1', a)).data.claims.length, 1);
    assert.equal((await call('GET', '/api/claims?mine=1', b)).data.claims.length, 0);
    assert.equal((await call('POST', '/api/release', { ...a, body: { all: true } })).data.released, 1);
    assert.equal((await call('GET', '/api/check?path=src/api/x.ts', b)).data.free, true);
  }));

  test('/api/wait resolves promptly when a message arrives', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const t0 = Date.now();
    const waiting = call('POST', '/api/wait?secs=5', { agent: 'bob', team: 'fe' });
    await new Promise((r) => setTimeout(r, 100));
    await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '@bob', text: 'wake up' } });
    const r = await waiting;
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.messages.map((m) => m.text), ['wake up']);
    assert.ok(!r.data.timeout);
  }));

  test('/api/wait returns immediately when mail is already pending', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '@bob', text: 'already' } });
    const t0 = Date.now();
    const r = await call('POST', '/api/wait?secs=5', { agent: 'bob' });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r.data.messages.length, 1);
  }));

  test('/api/wait is not woken by messages for others', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const t0 = Date.now();
    const waiting = call('POST', '/api/wait?secs=1', { agent: 'bob' });
    await new Promise((r) => setTimeout(r, 100));
    await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '#fe', text: 'no mention' } });
    const r = await waiting;
    assert.ok(Date.now() - t0 >= 900);
    assert.equal(r.data.timeout, true);
  }));

  test('/api/wait?secs=1 returns {timeout:true} with nothing', () => withServer(async ({ call }) => {
    await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
    const t0 = Date.now();
    const r = await call('POST', '/api/wait?secs=1', { agent: 'bob' });
    const dt = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.data.timeout, true);
    assert.deepEqual(r.data.messages, []);
    assert.ok(dt >= 900 && dt < 3000, `took ${dt}ms`);
  }));

  test('state survives close + restart on the same data file', async () => {
    const file = newFile();
    await withServer(async ({ call }) => {
      await call('POST', '/api/join', { agent: 'bob', team: 'fe' });
      await call('POST', '/api/send', { agent: 'alice', team: 'fe', body: { to: '@bob', text: 'persist me' } });
      await call('POST', '/api/claim', { agent: 'alice', team: 'fe', body: { paths: ['src/a.js'] } });
    }, file);
    assert.ok(fs.existsSync(file));
    await withServer(async ({ call, srv }) => {
      assert.equal(srv.bus.s.messages.length, 1);
      assert.equal(srv.bus.s.claims.length, 1);
      const c = await call('GET', '/api/claims');
      assert.deepEqual(c.data.claims.map((x) => [x.path, x.agent]), [['src/a.js', 'alice']]);
      const r = await call('POST', '/api/read', { agent: 'bob' });
      assert.deepEqual(r.data.messages.map((m) => m.text), ['persist me']);
      const blocked = await call('POST', '/api/claim', { agent: 'bob', body: { paths: ['src/a.js'] } });
      assert.equal(blocked.data.ok, false);
      const s = await call('POST', '/api/send', { agent: 'bob', body: { to: '@alice', text: 'next' } });
      assert.equal(s.data.message.id, 2, 'message ids continue after restart');
    }, file);
  });

  test('persisted file leaves no .tmp behind', async () => {
    const file = newFile();
    await withServer(async ({ call }) => { await call('POST', '/api/send', { body: { to: '', text: 'x' } }); }, file);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(file + '.tmp'));
  });
});
