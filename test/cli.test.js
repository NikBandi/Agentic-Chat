import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');

let tmp, srv, port;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-cli-'));
  srv = createServer({ dataFile: path.join(tmp, 'state.json'), port: 0 });
  port = await srv.listen();
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Async spawn: the server lives in this process, so a sync spawn would deadlock the event loop.
function bus(args, { agent, team, url = () => `http://127.0.0.1:${port}` } = {}) {
  const env = { ...process.env, BUS_URL: url() };
  delete env.BUS_AGENT; delete env.BUS_TEAM; delete env.BUS_PORT;
  if (agent) env.BUS_AGENT = agent;
  if (team) env.BUS_TEAM = team;
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout.trim(), err: stderr.trim() });
    });
  });
}

describe('cli', () => {
  test('notes + --context: take prints "read first" and the notes on its files, with no extra calls', async () => {
    const zed = { agent: 'zed', team: 'notes' };
    await bus(['join'], zed);
    const add = await bus(['note', 'add', 'notesdemo/', 'REST handlers;', 'auth in mw.js']);
    assert.notEqual(add.code, 0); // the human has no identity to sign a note with
    assert.match((await bus(['note', 'add', 'notesdemo/', 'REST handlers; auth lives in mw.js'], { agent: 'amy', team: 'notes' })).out, /^noted notesdemo\/$/);
    assert.match((await bus(['note', 'add', 'x', 'a\nb\nc\nd\ne\nf'], zed)).err, /at most 5 lines/);
    const t = await bus(['task', 'add', 'Users API', '--files', 'notesdemo/users.js', '--context', 'docs/api.md', '--check', 'node -v', '--for', 'zed']);
    assert.equal(t.code, 0, t.err);
    const id = t.out.match(/#(\d+)/)[1];
    const take = await bus(['task', 'take', id], zed);
    assert.equal(take.code, 0, take.err);
    assert.match(take.out, /^read first: docs\/api\.md$/m);
    assert.match(take.out, /^notesdemo\/ \(amy, \d+s ago\): REST handlers; auth lives in mw\.js$/m);
    assert.match((await bus(['note', 'notesdemo/'], zed)).out, /^notesdemo\/ \(amy/);
    assert.match((await bus(['note', 'list'], zed)).out, /^notesdemo\/ \(amy, \d+s ago\)$/);
    assert.equal((await bus(['note', 'rm', 'notesdemo/'], zed)).code, 1); // not the author, not a lead
    assert.match((await bus(['note', 'rm', 'notesdemo/'], { agent: 'amy', team: 'notes' })).out, /^removed note on notesdemo\/$/);
  });

  test('usage: says so when nothing is recorded yet', async () => {
    assert.match((await bus(['usage'])).out, /^no usage recorded yet/);
  });

  test('join, who', async () => {
    const j = await bus(['join'], { agent: 'bob', team: 'frontend' });
    assert.equal(j.code, 0, j.err);
    assert.equal(j.out, 'joined as bob (team frontend)');
    const w = await bus(['who'], { agent: 'bob', team: 'frontend' });
    assert.match(w.out, /^bob frontend task:- seen:\d+s$/m);
  });

  test('send and read: one-line "id from>#channel: text"', async () => {
    await bus(['join'], { agent: 'bob', team: 'frontend' });
    const s = await bus(['send', '@frontend', 'hi'], { agent: 'alice', team: 'frontend' });
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /^sent \d+$/);
    const id = s.out.split(' ')[1];
    const r = await bus(['read'], { agent: 'bob', team: 'frontend' });
    assert.equal(r.code, 0);
    assert.equal(r.out, `${id} alice>#frontend: hi`);
    const r2 = await bus(['read'], { agent: 'bob', team: 'frontend' });
    assert.equal(r2.out, 'no new messages');
  });

  test('DM format and multi-word text', async () => {
    await bus(['join'], { agent: 'bob', team: 'frontend' });
    const s = await bus(['send', '@bob', 'two', 'words'], { agent: 'alice', team: 'frontend' });
    const id = s.out.split(' ')[1];
    const r = await bus(['read'], { agent: 'bob', team: 'frontend' });
    assert.equal(r.out, `${id} alice>@bob: two words`);
  });

  test('long messages are truncated with a bus show hint', async () => {
    await bus(['join'], { agent: 'bob', team: 'frontend' });
    const s = await bus(['send', '@bob', 'x'.repeat(500)], { agent: 'alice', team: 'frontend' });
    const id = s.out.split(' ')[1];
    const r = await bus(['read'], { agent: 'bob', team: 'frontend' });
    assert.ok(r.out.endsWith(`… (bus show ${id})`));
    assert.ok(r.out.length < 300);
    const full = await bus(['show', id], { agent: 'bob', team: 'frontend' });
    assert.ok(full.out.includes('x'.repeat(500)));
  });

  test('claim ok, then conflicting claim exits 1 with "blocked:"', async () => {
    const a = await bus(['claim', 'src/api/', '-m', 'api work'], { agent: 'alice', team: 'frontend' });
    assert.equal(a.code, 0, a.err);
    assert.equal(a.out, 'claimed src/api/');
    const b = await bus(['claim', 'src/api/users.ts'], { agent: 'bob', team: 'frontend' });
    assert.equal(b.code, 1);
    assert.match(b.out, /^blocked: src\/api\/users\.ts overlaps src\/api\/ held by alice/);
    const ck = await bus(['check', 'src/api/users.ts'], { agent: 'bob', team: 'frontend' });
    assert.equal(ck.code, 1);
    assert.equal(ck.out, 'claimed by alice (src/api/)');
    const ca = await bus(['check', 'src/api/users.ts'], { agent: 'alice', team: 'frontend' });
    assert.equal(ca.out, 'free (yours)');
    const rel = await bus(['release', '--all'], { agent: 'alice', team: 'frontend' });
    assert.equal(rel.out, 'released src/api/');
    assert.equal((await bus(['claims'], { agent: 'bob' })).out.includes('src/api/'), false);
  });

  test('read without BUS_AGENT exits 1', async () => {
    const r = await bus(['read']);
    assert.equal(r.code, 1);
    assert.match(r.err, /BUS_AGENT/);
  });

  test('unknown command exits 2', async () => {
    const r = await bus(['frobnicate']);
    assert.equal(r.code, 2);
  });

  test('no server running: "bus who" exits 1 with a "not running" message', async () => {
    const dead = await new Promise((ok) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
    });
    const r = await bus(['who'], { url: () => `http://127.0.0.1:${dead}` });
    assert.equal(r.code, 1);
    assert.match(r.err, /not running/);
  });
});
