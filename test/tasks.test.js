import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus, BusError } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { tail, currentBranch } from '../src/check.js';
import { createServer } from '../src/server.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');
const PASS = 'node -e "process.exit(0)"';
const FAIL = `node -e "console.log('boom');process.exit(3)"`;
const SLEEP = (ms) => `node -e "setTimeout(()=>{},${ms})"`;
const EXISTS_OK = `node -e "process.exit(require('fs').existsSync('ok.txt')?0:4)"`;

let tmp, bus, tasks, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-tasks-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

beforeEach(() => {
  bus = new Bus(new Store(null));
  tasks = new Tasks(bus);
  bus.touch('lead');
});

/** Register an agent with deterministic join order and a private worktree dir. */
function agent(name, team = 'fe') {
  const dir = path.join(tmp, `wt${++n}`);
  fs.mkdirSync(dir);
  const a = bus.touch(name, team, dir);
  a.joinedAt = n;
  return a;
}
const add = (o = {}, who = 'lead') => tasks.add(who, { title: 'T', check: PASS, ...o });
const dms = (name) => bus.s.messages.filter((m) => m.to === name && m.from === 'bus').map((m) => m.text);
const code = (fn, status) => assert.throws(fn, (e) => e instanceof BusError && (status === undefined || e.status === status));

describe('permissions', () => {
  test('only lead/human add', () => {
    agent('alice');
    code(() => tasks.add('alice', { title: 'x', check: PASS }), 403);
    assert.ok(tasks.add('lead', { title: 'x', check: PASS }));
    assert.ok(tasks.add('you', { title: 'x', check: PASS }));
  });
  test('only lead/human merged, reassign, drop', () => {
    agent('alice'); agent('bob');
    const t = add();
    for (const fn of [() => tasks.merged('alice', t.id), () => tasks.reassign('alice', t.id, 'bob'), () => tasks.drop('alice', t.id)]) code(fn, 403);
  });
  test('only the human approves/rejects (not even lead)', () => {
    agent('alice');
    const t = add();
    for (const who of ['lead', 'alice']) {
      code(() => tasks.approve(who, t.id), 403);
      code(() => tasks.reject(who, t.id, 'x'), 403);
    }
  });
  test('only the owner runs done', async () => {
    agent('alice'); agent('bob');
    const t = add({ assignee: 'alice' });
    tasks.take('alice', t.id);
    await assert.rejects(tasks.done('bob', t.id), (e) => e.status === 403);
    await assert.rejects(tasks.done('lead', t.id), (e) => e.status === 403);
  });
});

describe('add validation', () => {
  test('title required', () => code(() => tasks.add('lead', { title: '  ', check: PASS }), 400));
  test('check required', () => {
    code(() => tasks.add('lead', { title: 'x' }), 400);
    code(() => tasks.add('lead', { title: 'x', check: ' ' }), 400);
  });
  test('unknown dependency id', () => code(() => add({ after: [42] }), 404));
  test('dependency accepts #id, dedupes, assigns sequential ids', () => {
    const a = add(); const b = add({ after: ['#1', 1] });
    assert.deepEqual([a.id, b.id], [1, 2]);
    assert.deepEqual(b.after, [1]);
  });
  test('timeout is clamped to 1..3600, default 600', () => {
    assert.equal(add({ timeout: 99999 }).timeout, 3600);
    assert.equal(add({ timeout: 0 }).timeout, 600);
    assert.equal(add().timeout, 600);
    assert.equal(add({ timeout: -5 }).timeout, 1);
  });
});

describe('offers', () => {
  test('assignee agent gets a DM, even when busy', () => {
    agent('alice'); agent('bob').task = 99;
    const t = add({ assignee: 'bob' });
    assert.equal(dms('bob').length, 1);
    assert.match(dms('bob')[0], new RegExp(`task #${t.id} ready for you`));
    assert.equal(dms('alice').length, 0);
  });
  test('team task goes to ONE free member: first joined', () => {
    agent('alice'); agent('bob'); agent('carol');
    add({ assignee: 'fe' });
    assert.equal(dms('alice').length, 1);
    assert.equal(dms('bob').length, 0);
    assert.equal(dms('carol').length, 0);
  });
  test('team task skips busy members and the lead', () => {
    agent('alice').task = 7; agent('bob');
    bus.s.agents.lead.team = 'fe';
    add({ assignee: 'fe' });
    assert.equal(dms('alice').length, 0);
    assert.equal(dms('lead').length, 0);
    assert.equal(dms('bob').length, 1);
  });
  test('member of another team is not offered a team task', () => {
    agent('zed', 'be');
    add({ assignee: 'fe' });
    assert.equal(dms('zed').length, 0);
  });
  test('agent joining later is offered an open task it may take', () => {
    const t = add({ assignee: 'fe' });
    assert.deepEqual(t.offered, []);
    agent('carol');
    assert.equal(dms('carol').length, 1);
    assert.deepEqual(t.offered, ['carol']);
  });
  test('named assignee joining later is offered; other agents are not', () => {
    add({ assignee: 'dave' });
    agent('erin');
    assert.equal(dms('erin').length, 0);
    agent('dave');
    assert.equal(dms('dave').length, 1);
  });
  test('DM sent before joining is delivered via inbox', () => {
    add({ assignee: 'dave' });
    agent('dave');
    assert.equal(bus.read('dave').messages.length, 1);
  });
  test('no duplicate offers', () => {
    agent('alice');
    const t = add({ assignee: 'alice' });
    tasks.offer(t); tasks.offer(t); tasks.offerNext('alice'); bus.emit('join', bus.s.agents.alice);
    assert.equal(dms('alice').length, 1);
  });
  test('task with unmet deps is not offered until deps merge', () => {
    agent('alice');
    add({ assignee: 'x' });
    const t2 = add({ after: [1], assignee: 'alice' });
    assert.equal(dms('alice').length, 0);
    assert.deepEqual(t2.offered, []);
  });
});

describe('take', () => {
  test('blocked by unmet deps', () => {
    agent('alice');
    const a = add({ assignee: 'x' }); const b = add({ after: [a.id] });
    code(() => tasks.take('alice', b.id), 409);
    assert.throws(() => tasks.take('alice', b.id), /waits on #1/);
  });
  test('wrong assignee agent or team', () => {
    agent('alice'); agent('zed', 'be');
    const t = add({ assignee: 'bob' }); const u = add({ assignee: 'fe' });
    code(() => tasks.take('alice', t.id), 403);
    code(() => tasks.take('zed', u.id), 403);
    assert.ok(tasks.take('alice', u.id));
  });
  test('unregistered caller and unknown task', () => {
    const t = add();
    code(() => tasks.take('ghost', t.id), 400);
    agent('alice');
    code(() => tasks.take('alice', 99), 404);
  });
  test('one task at a time; retake of own task is idempotent', () => {
    agent('alice');
    const a = add(); const b = add();
    tasks.take('alice', a.id);
    assert.equal(tasks.take('alice', a.id).id, a.id);
    code(() => tasks.take('alice', b.id), 409);
    assert.equal(b.status, 'open');
  });
  test('cannot take a task someone else owns', () => {
    agent('alice'); agent('bob');
    const t = add(); tasks.take('alice', t.id);
    assert.throws(() => tasks.take('bob', t.id), /in_progress \(alice\)/);
  });
  test('claims the task files and sets owner/status', () => {
    agent('alice');
    const t = add({ files: ['src/a.js', 'docs/'] });
    tasks.take('alice', t.id);
    assert.equal(t.status, 'in_progress'); assert.equal(t.owner, 'alice');
    assert.equal(bus.s.agents.alice.task, t.id);
    assert.deepEqual(bus.claims('alice').map((c) => c.path).sort(), ['docs/', 'src/a.js']);
  });
  test('claim conflict -> error and nothing claimed', () => {
    agent('alice'); agent('bob');
    bus.claim('bob', ['src/a.js']);
    const t = add({ files: ['docs/', 'src/'] });
    code(() => tasks.take('alice', t.id), 409);
    assert.throws(() => tasks.take('alice', t.id), /src\/.*held by bob/);
    assert.equal(bus.claims('alice').length, 0);
    assert.equal(t.status, 'open'); assert.equal(t.owner, null);
    assert.equal(bus.s.agents.alice.task, null);
  });
});

describe('done', () => {
  test('failing check stays in_progress, returns tail + exit code', async () => {
    agent('alice');
    const t = add({ check: FAIL }); tasks.take('alice', t.id);
    const r = await tasks.done('alice', t.id);
    assert.equal(r.ok, false); assert.equal(r.code, 3);
    assert.match(r.output, /boom/);
    assert.equal(t.status, 'in_progress');
    assert.equal(bus.s.mergeRequests.length, 0);
    assert.equal(t.result.ok, false);
    assert.equal(dms('lead').length, 0);
  });
  test('passing check -> review, merge request, lead notified', async () => {
    agent('alice');
    const t = add(); tasks.take('alice', t.id);
    const r = await tasks.done('alice', t.id, ' all good ');
    assert.equal(r.ok, true);
    assert.equal(t.status, 'review');
    assert.equal(t.summary, 'all good');
    assert.equal(bus.s.mergeRequests.length, 1);
    assert.deepEqual({ task: r.mr.task, agent: r.mr.agent, status: r.mr.status }, { task: t.id, agent: 'alice', status: 'pending' });
    const m = dms('lead');
    assert.equal(m.length, 1);
    assert.match(m[0], /#1 passed its check \(alice/);
    assert.match(m[0], /all good/);
  });
  test('check runs in the owner worktree', async () => {
    const a = agent('alice');
    fs.writeFileSync(path.join(a.worktree, 'ok.txt'), 'x');
    const t = add({ check: EXISTS_OK });
    tasks.take('alice', t.id);
    assert.equal((await tasks.done('alice', t.id)).ok, true);
  });
  test('done requires ownership, known task and a worktree', async () => {
    agent('alice');
    const t = add({ assignee: 'alice' });
    await assert.rejects(tasks.done('alice', t.id), (e) => e.status === 403); // not owner yet
    await assert.rejects(tasks.done('alice', 99), (e) => e.status === 404);
    tasks.take('alice', t.id);
    bus.s.agents.alice.worktree = null;
    await assert.rejects(tasks.done('alice', t.id), (e) => e.status === 400 && /worktree/.test(e.message));
    assert.equal(tasks.running.size, 0);
  });
  test('done in review state is rejected', async () => {
    agent('alice');
    const t = add(); tasks.take('alice', t.id);
    await tasks.done('alice', t.id);
    await assert.rejects(tasks.done('alice', t.id), (e) => e.status === 409);
  });
  test('check timeout fails the task', async () => {
    agent('alice');
    const t = add({ check: SLEEP(20000), timeout: 1 }); tasks.take('alice', t.id);
    assert.equal(t.timeout, 1);
    const r = await tasks.done('alice', t.id);
    assert.equal(r.ok, false);
    assert.match(r.output, /timed out after 1s/);
    assert.equal(t.status, 'in_progress');
    assert.equal(tasks.running.size, 0);
  });
  test('concurrent second done while running is rejected', async () => {
    agent('alice');
    const t = add({ check: SLEEP(600) }); tasks.take('alice', t.id);
    const first = tasks.done('alice', t.id);
    await assert.rejects(tasks.done('alice', t.id), (e) => e.status === 409 && /already running/.test(e.message));
    assert.equal((await first).ok, true);
    assert.equal(bus.s.mergeRequests.length, 1);
  });
  test('task reassigned while check runs -> done errors, no merge request', async () => {
    agent('alice'); agent('bob');
    const t = add({ check: SLEEP(500) }); tasks.take('alice', t.id);
    const p = tasks.done('alice', t.id);
    tasks.reassign('lead', t.id, 'bob');
    await assert.rejects(p, (e) => e.status === 409);
    assert.equal(bus.s.mergeRequests.length, 0);
    assert.equal(t.status, 'open');
  });
});

/** Drive a task to review state. */
async function toReview(opts = {}, who = 'alice') {
  const t = add(opts); tasks.take(who, t.id);
  await tasks.done(who, t.id, 'sum');
  return t;
}

describe('approve / reject', () => {
  test('approve -> approved, MR approved, lead notified', async () => {
    agent('alice');
    const t = await toReview();
    tasks.approve('you', t.id);
    assert.equal(t.status, 'approved');
    assert.equal(bus.s.mergeRequests[0].status, 'approved');
    assert.match(dms('lead').at(-1), /#1 approved — merge/);
  });
  test('approve requires review state', () => {
    agent('alice');
    const t = add();
    code(() => tasks.approve('you', t.id), 409);
  });
  test('reject -> in_progress, owner + lead notified, MR rejected', async () => {
    agent('alice');
    const t = await toReview();
    tasks.reject('you', t.id, 'needs tests');
    assert.equal(t.status, 'in_progress');
    assert.deepEqual({ s: bus.s.mergeRequests[0].status, r: bus.s.mergeRequests[0].reason }, { s: 'rejected', r: 'needs tests' });
    assert.match(dms('alice').at(-1), /#1 rejected: needs tests/);
    assert.match(dms('lead').at(-1), /#1 rejected: needs tests/);
  });
  test('reject without reason, and from approved state', async () => {
    agent('alice');
    const t = await toReview();
    tasks.approve('you', t.id);
    tasks.reject('you', t.id);
    assert.equal(t.status, 'in_progress');
    assert.match(dms('alice').at(-1), /no reason given/);
    code(() => tasks.reject('you', t.id, 'again'), 409); // now in_progress
  });
  test('after reject the owner can redo; a fresh MR replaces the old one', async () => {
    agent('alice');
    const t = await toReview();
    tasks.reject('you', t.id, 'x');
    assert.equal((await tasks.done('alice', t.id)).ok, true);
    assert.equal(bus.s.mergeRequests.length, 1);
    assert.equal(bus.s.mergeRequests[0].status, 'pending');
    assert.equal(t.status, 'review');
  });
  test('chat "approve #N" from the human works', async () => {
    agent('alice');
    const t = await toReview();
    bus.send('you', '@lead', 'approve #1');
    assert.equal(t.status, 'approved');
  });
  test('chat "reject #N reason" works; lead mentioned -> not double-notified', async () => {
    agent('alice');
    const t = await toReview();
    const before = dms('lead').length;
    bus.send('you', '@lead', 'reject #1: too slow, fix it');
    assert.equal(t.status, 'in_progress');
    assert.equal(bus.s.mergeRequests[0].reason, 'too slow, fix it');
    assert.match(dms('alice').at(-1), /too slow, fix it/);
    assert.equal(dms('lead').length, before);
  });
  test('chat reject without mentioning lead notifies the lead', async () => {
    agent('alice');
    await toReview();
    const before = dms('lead').length;
    bus.send('you', '#general', 'reject #1 nope');
    assert.equal(dms('lead').length, before + 1);
  });
  test('invalid chat approval notifies "you" with an error', () => {
    agent('alice');
    bus.send('you', '@lead', 'approve #99');
    assert.match(dms('you').at(-1), /couldn't apply "approve #99".*no task 99/);
    const t = add();
    bus.send('you', '@lead', 'approve #' + t.id);
    assert.match(dms('you').at(-1), /not awaiting approval/);
    bus.send('you', '@lead', 'reject #' + t.id + ' meh');
    assert.match(dms('you').at(-1), /nothing to reject/);
  });
  test('agents cannot approve via chat', async () => {
    agent('alice');
    const t = await toReview();
    bus.send('alice', '@lead', 'approve #1');
    assert.equal(t.status, 'review');
  });
});

describe('merged', () => {
  test('requires approved', async () => {
    agent('alice');
    const t = await toReview();
    code(() => tasks.merged('lead', t.id), 409);
    assert.equal(t.status, 'review');
  });
  test('releases ALL owner claims, clears agent.task, marks MR merged', async () => {
    agent('alice');
    const t = await toReview({ files: ['src/a.js'] });
    bus.claim('alice', ['extra/b.js']);
    assert.equal(bus.claims('alice').length, 2);
    tasks.approve('you', t.id);
    tasks.merged('lead', t.id);
    assert.equal(t.status, 'merged');
    assert.equal(bus.claims('alice').length, 0);
    assert.equal(bus.s.agents.alice.task, null);
    assert.equal(bus.s.mergeRequests[0].status, 'merged');
  });
  test('dependents get "merged — rebase and start" offer; owner gets next task', async () => {
    agent('alice');
    const t1 = add({ assignee: 'alice' });
    tasks.take('alice', t1.id);
    const t2 = add({ after: [t1.id], assignee: 'alice' });
    const t3 = add({ title: 'next' });
    assert.deepEqual(t3.offered, []); // alice is busy, nobody else free
    await tasks.done('alice', t1.id);
    tasks.approve('you', t1.id);
    const before = dms('alice').length;
    tasks.merged('lead', t1.id);
    const got = dms('alice').slice(before);
    assert.equal(got.length, 2);
    assert.match(got[0], new RegExp(`^#${t1.id} merged — rebase and start: task #${t2.id} ready for you`));
    assert.match(got[1], new RegExp(`^task #${t3.id} ready for you: next`));
  });
  test('dependents are only offered once all deps merged', async () => {
    agent('alice'); agent('bob');
    const a = add({ assignee: 'alice' }); const b = add({ assignee: 'alice' });
    const c = add({ after: [a.id, b.id], assignee: 'bob' });
    tasks.take('alice', a.id);
    await tasks.done('alice', a.id); tasks.approve('you', a.id); tasks.merged('lead', a.id);
    assert.equal(dms('bob').length, 0);
    tasks.take('alice', b.id);
    await tasks.done('alice', b.id); tasks.approve('you', b.id); tasks.merged('lead', b.id);
    assert.equal(dms('bob').length, 1);
    assert.match(dms('bob')[0], /merged — rebase and start/);
    assert.ok(tasks.take('bob', c.id));
  });
});

describe('reassign / drop', () => {
  for (const [name, op] of [
    ['reassign', (t) => tasks.reassign('lead', t.id, 'bob')],
    ['drop', (t) => tasks.drop('you', t.id)],
  ]) {
    test(`${name} releases claims, notifies old owner, removes pending MR`, async () => {
      agent('alice'); agent('bob');
      const t = await toReview({ files: ['src/a.js'], assignee: 'alice' });
      assert.equal(bus.s.mergeRequests.length, 1);
      const before = dms('alice').length;
      op(t);
      assert.equal(bus.claims('alice').length, 0);
      assert.equal(bus.s.agents.alice.task, null);
      assert.equal(bus.s.mergeRequests.length, 0);
      assert.match(dms('alice')[before], new RegExp(name === 'drop' ? 'was dropped' : 'reassigned to bob'));
    });
  }
  test('reassign reopens for new assignee and offers it; fresh offered list', () => {
    agent('alice'); agent('bob');
    const t = add({ assignee: 'alice' }); tasks.take('alice', t.id);
    tasks.reassign('lead', t.id, 'bob');
    assert.equal(t.status, 'open'); assert.equal(t.owner, null); assert.equal(t.assignee, 'bob');
    assert.deepEqual(t.offered, ['bob']);
    assert.match(dms('bob').at(-1), /task #1 ready for you/);
  });
  test('drop marks dropped and frees the owner for the next task', () => {
    agent('alice');
    const t = add(); tasks.take('alice', t.id);
    const u = add({ title: 'other' });
    tasks.drop('lead', t.id);
    assert.equal(t.status, 'dropped');
    assert.match(dms('alice').at(-1), new RegExp(`task #${u.id} ready for you`));
    code(() => tasks.take('alice', t.id), 409);
  });
  test('reassign validation: unknown agent, merged/dropped task', async () => {
    agent('alice');
    const t = add();
    code(() => tasks.reassign('lead', t.id, 'nobody'), 404);
    tasks.drop('lead', t.id);
    code(() => tasks.reassign('lead', t.id, 'alice'), 409);
    const m = await toReview(); tasks.approve('you', m.id); tasks.merged('lead', m.id);
    code(() => tasks.drop('lead', m.id), 409);
  });
});

describe('list', () => {
  test('--mine shows own tasks plus open takeable ones', () => {
    agent('alice'); agent('bob');
    const a = add({ assignee: 'alice' }); add({ assignee: 'bob' }); const c = add();
    tasks.take('alice', a.id);
    const ids = tasks.list('alice', true).map((t) => t.id).sort();
    assert.deepEqual(ids, [a.id, c.id]);
    assert.equal(tasks.list('alice').length, 3);
  });
});

describe('check.js', () => {
  test('tail keeps the last 25 lines and notes the cut', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n');
    const lines = tail(text).split('\n');
    assert.match(lines[0], /^…\(15 lines cut\)$/);
    assert.equal(lines.length, 26);
    assert.equal(lines[1], 'line16');
    assert.equal(lines.at(-1), 'line40');
  });
  test('tail strips ANSI and normalises CRLF', () => {
    assert.equal(tail('\x1b[31mred\x1b[0m\r\nok\x1b[2K\r\n\n'), 'red\nok');
  });
  test('tail caps characters', () => {
    const out = tail('x'.repeat(5000));
    assert.match(out, /^…\(2500 chars cut\)\n/);
    assert.equal(out.split('\n')[1].length, 2500);
  });
  test('currentBranch is null outside a repo', async () => {
    assert.equal(await currentBranch(tmp), null);
  });
});

// ---- end-to-end through HTTP + CLI --------------------------------------------------------------

function git(cwd, ...args) { return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' }); }

function cli(port, { agent: who, team, cwd }, args) {
  const env = { ...process.env, BUS_URL: `http://127.0.0.1:${port}` };
  delete env.BUS_AGENT; delete env.BUS_TEAM; delete env.BUS_PORT;
  if (who) env.BUS_AGENT = who;
  if (team) env.BUS_TEAM = team;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: cwd || tmp, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 15000);
    p.on('close', (c) => { clearTimeout(timer); resolve({ code: c, out: out.trim(), err: err.trim() }); });
  });
}

describe('end to end (HTTP server + bus CLI)', () => {
  let srv, port, repo, hasGit = true;
  before(async () => {
    repo = path.join(tmp, 'repo');
    srv = createServer({ port: 0, repoDir: repo });
    port = await srv.listen();
    fs.mkdirSync(repo);
    try { git(repo, 'init'); git(repo, 'commit', '--allow-empty', '-m', 'init'); }
    catch { hasGit = false; fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); }
  });
  after(() => srv.close());

  test('add -> take -> done (fail, then pass) -> approve -> merged', async () => {
    const lead = { agent: 'lead', cwd: repo }, worker = { agent: 'alice', team: 'fe', cwd: repo }, human = {};
    let r = await cli(port, worker, ['join']);
    assert.equal(r.code, 0, r.err);
    const norm = (p) => fs.realpathSync.native(p).split(path.sep).join('/').toLowerCase();
    assert.equal(norm(srv.bus.s.agents.alice.worktree), norm(repo));

    // a worker cannot add tasks
    r = await cli(port, worker, ['task', 'add', 'nope', '--check', PASS]);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /only a lead, the head or the human/);

    r = await cli(port, lead, ['task', 'add', 'Build thing', '--files', 'src/a.js', '--check', EXISTS_OK, '--for', 'fe']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#1/);
    assert.equal(srv.bus.s.messages.filter((m) => m.to === 'alice').length, 1); // offer

    r = await cli(port, worker, ['task', 'take', '1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.tasks.get(1).status, 'in_progress');
    assert.equal(srv.bus.claims('alice').length, 1);

    r = await cli(port, worker, ['task', 'done', '1', 'built', 'it']);
    assert.match(r.out, /check failed \(exit 4\)/);
    assert.equal(srv.tasks.get(1).status, 'in_progress');

    fs.writeFileSync(path.join(repo, 'ok.txt'), 'x');
    if (hasGit) {
      r = await cli(port, worker, ['task', 'done', '1', 'built', 'it']);
      assert.equal(r.err, 'bus: commit your changes first (1 file uncommitted)');
      git(repo, 'add', 'ok.txt'); git(repo, 'commit', '-m', 'ok');
    }
    r = await cli(port, worker, ['task', 'done', '1', 'built', 'it']);
    assert.match(r.out, /check passed/);
    assert.equal(srv.tasks.get(1).status, 'review');
    if (hasGit) {
      assert.ok(srv.tasks.get(1).branch, 'branch recorded');
      assert.match(srv.tasks.get(1).commit, /^[0-9a-f]{40}$/);
      r = await cli(port, worker, ['task', 'show', '1']);
      assert.match(r.out, new RegExp(`^commit: ${srv.tasks.get(1).commit.slice(0, 7)} on `, 'm'));
    }
    assert.equal(srv.tasks.get(1).summary, 'built it');

    // agents cannot approve; lead cannot mark merged before approval
    r = await cli(port, worker, ['approve', '1']);
    assert.notEqual(r.code, 0);
    r = await cli(port, lead, ['task', 'merged', '1']);
    assert.notEqual(r.code, 0);

    r = await cli(port, human, ['approve', '1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.tasks.get(1).status, 'approved');

    r = await cli(port, lead, ['task', 'merged', '1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.tasks.get(1).status, 'merged');
    assert.equal(srv.bus.claims('alice').length, 0);
    assert.equal(srv.bus.s.agents.alice.task, null);

    r = await cli(port, lead, ['task', 'list']);
    assert.match(r.out, /#1/);
    assert.match(r.out, /merged/);
  });

  test('reject via CLI sends the task back to the owner', async () => {
    const lead = { agent: 'lead' }, worker = { agent: 'bob', team: 'fe', cwd: repo };
    await cli(port, worker, ['join']);
    await cli(port, lead, ['task', 'add', 'Second', '--check', PASS, '--for', 'bob']);
    const id = srv.tasks.s.tasks.at(-1).id;
    await cli(port, worker, ['task', 'take', String(id)]);
    await cli(port, worker, ['task', 'done', String(id)]);
    assert.equal(srv.tasks.get(id).status, 'review');
    const r = await cli(port, {}, ['reject', String(id), 'not', 'good']);
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.tasks.get(id).status, 'in_progress');
    assert.match(srv.bus.s.messages.filter((m) => m.to === 'bob').at(-1).text, /rejected: not good/);
  });
});
