// Lead-spawned workers: worktree per worker, headless claude, max 4 at once, queue, respawn on reject.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bus, BusError } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Spawner, workerPrompt, workerArgs, maxWorkers } from '../src/spawn.js';

const PASS = 'node -e "process.exit(0)"';
let tmp, repo, bus, tasks, sp, launched, n = 0;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-spawn-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Fake launcher: records each start; tests end a worker with launched[i].exit(code). */
const makeLauncher = (into) => function fakeLauncher(opts) {
  const rec = { ...opts, killed: false, exitFn: null };
  rec.exit = (code = 0) => rec.exitFn?.(code);
  into.push(rec);
  return { pid: 1000 + into.length, kill: () => { rec.killed = true; rec.exit(null); }, onExit: (fn) => { rec.exitFn = fn; } };
};

/** Let pending pumps (async git worktree add) finish. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    while (sp.pumping) await new Promise((r) => setTimeout(r, 20));
  }
}
const dms = (name) => bus.s.messages.filter((m) => m.to === name && m.from === 'bus').map((m) => m.text);
const code = (fn, status) => assert.throws(fn, (e) => e instanceof BusError && (status === undefined || e.status === status));

beforeEach(() => {
  repo = path.join(tmp, `repo${++n}`);
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  launched = [];
  bus = new Bus(new Store(null));
  tasks = new Tasks(bus, { repo });
  sp = new Spawner(bus, tasks, { repo, dataDir: path.join(repo, '.bus'), launcher: makeLauncher(launched), env: { BUS_CLAUDE: 'claude' }, port: 4477 });
  bus.touch('head', '', repo, 'head');
  bus.touch('fe-lead', 'frontend', repo, 'lead');
  bus.touch('be-lead', 'backend', repo, 'lead');
});

const feTask = (o = {}) => tasks.add('fe-lead', { title: 'T', check: PASS, ...o });

describe('spawning', () => {
  test('a lead spawns a worker: own worktree + branch, headless claude with only the task, minimal hooks', async () => {
    const t = feTask({ title: 'Hero' });
    const w = sp.request('fe-lead', t.id);
    await settle();
    assert.equal(w.name, 'frontend-1');
    assert.equal(w.status, 'running');
    assert.equal(launched.length, 1);
    const L = launched[0];
    assert.equal(L.cwd, path.join(tmp, `repo${n}-frontend-1`));
    assert.ok(fs.existsSync(L.cwd));
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: L.cwd, encoding: 'utf8' }).trim(), 'frontend-1');
    assert.equal(L.env.BUS_AGENT, 'frontend-1');
    assert.equal(L.env.BUS_TEAM, 'frontend');
    assert.equal(L.env.ECC_HOOK_PROFILE, 'minimal');
    assert.equal(L.env.BUS_ROLE, undefined);
    assert.equal(L.env.BUS_PORT, '4477');
    assert.equal(L.args[0], '-p');
    assert.match(L.args[1], new RegExp(`task take ${t.id}`));
    const settings = JSON.parse(fs.readFileSync(L.args[L.args.indexOf('--settings') + 1], 'utf8'));
    assert.ok(settings.hooks.PreToolUse.length >= 2);
    assert.equal(t.assignee, 'frontend-1'); // reserved for it
    assert.equal(bus.s.agents['frontend-1'].spawned, true);
    assert.equal(dms('frontend-1').length, 0); // no offer DM: the prompt already names the task
  });

  test("only the task's lead, the head or the human may spawn; tasks need a team and must be open", async () => {
    const t = feTask();
    code(() => sp.request('be-lead', t.id), 403);
    bus.touch('w', 'frontend', repo);
    code(() => sp.request('w', t.id), 403);
    const loose = tasks.add('head', { title: 'no team', check: PASS });
    code(() => sp.request('head', loose.id), 400);
    assert.ok(sp.request('head', t.id));
    const again = sp.request('fe-lead', t.id); // same task twice -> same worker, not a second one
    await settle();
    assert.equal(again.name, 'frontend-1');
    assert.equal(launched.length, 1);
    const done = feTask({ title: 'x' });
    done.status = 'merged';
    code(() => sp.request('fe-lead', done.id), 409);
  });

  test('at most 4 run at once (bus-wide); the rest queue and start as workers exit', async () => {
    const fe = [1, 2, 3, 4, 5].map(() => feTask().id);
    const be = tasks.add('be-lead', { title: 'B', check: PASS }).id;
    for (const id of fe) sp.request('fe-lead', id);
    sp.request('be-lead', be);
    await settle();
    assert.equal(sp.max, 4);
    assert.equal(sp.running().length, 4);
    assert.equal(sp.list().filter((w) => w.status === 'queued').length, 2);
    launched[0].exit(0);
    await settle();
    assert.equal(sp.running().length, 4);
    assert.equal(launched.length, 5);
    assert.equal(launched[4].env.BUS_AGENT, 'frontend-5'); // first queued, first started
  });

  test('BUS_MAX_WORKERS overrides the cap (clamped to 1..16)', () => {
    assert.equal(maxWorkers({}), 4);
    assert.equal(maxWorkers({ BUS_MAX_WORKERS: '2' }), 2);
    assert.equal(maxWorkers({ BUS_MAX_WORKERS: '0' }), 4);
    assert.equal(maxWorkers({ BUS_MAX_WORKERS: '99' }), 16);
  });

  test('a task waiting on dependencies stays queued (no slot used) until they merge', async () => {
    const a = feTask({ title: 'tokens' });
    const b = feTask({ title: 'hero', after: [a.id] });
    sp.request('fe-lead', b.id);
    await settle();
    assert.equal(launched.length, 0);
    assert.equal(sp.list()[0].status, 'queued');
    Object.assign(a, { status: 'approved', owner: null, commit: null });
    bus.s.mergeRequests.push({ task: a.id, status: 'approved' });
    await tasks.merged('fe-lead', a.id);
    await settle();
    assert.equal(launched.length, 1);
  });

  test('a worker that exits without handing in its task tells the lead once; one that finished does not', async () => {
    const t1 = feTask(); const t2 = feTask();
    sp.request('fe-lead', t1.id); sp.request('fe-lead', t2.id);
    await settle();
    tasks.take('frontend-2', t2.id);
    t2.status = 'review'; // handed in
    launched[0].exit(1); launched[1].exit(0);
    await settle();
    const notes = dms('fe-lead').filter((m) => m.includes('exited'));
    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp(`frontend-1 exited with #${t1.id} unfinished`));
  });

  test('a rejected task re-spawns its (exited) worker in the same worktree, with the reason', async () => {
    const t = feTask();
    sp.request('fe-lead', t.id);
    await settle();
    tasks.take('frontend-1', t.id);
    const r = await tasks.done('frontend-1', t.id);
    assert.equal(r.ok, true);
    launched[0].exit(0);
    await settle();
    tasks.reject('you', t.id, 'spacing is off');
    await settle();
    assert.equal(launched.length, 2);
    assert.equal(launched[1].cwd, launched[0].cwd);
    assert.match(launched[1].args[1], /sent back: spacing is off/);
    assert.equal(sp.s.spawns['frontend-1'].runs, 2);
  });

  test('stop: kills a running worker (no "unfinished" notice) or cancels a queued one', async () => {
    for (let i = 0; i < 5; i++) sp.request('fe-lead', feTask().id);
    await settle();
    code(() => sp.stop('be-lead', 'frontend-1'), 403);
    assert.equal(sp.stop('fe-lead', 'frontend-5').status, 'exited'); // queued -> cancelled
    sp.stop('fe-lead', 'frontend-1');
    await settle();
    assert.equal(launched[0].killed, true);
    assert.ok(!dms('fe-lead').some((m) => m.includes('frontend-1 exited')));
    assert.equal(launched.length, 4); // the cancelled one never started
  });

  test('spawned workers are never auto-offered other tasks, and are not flagged inactive after exiting', async () => {
    const t = feTask();
    sp.request('fe-lead', t.id);
    await settle();
    launched[0].exit(0);
    await settle();
    feTask({ title: 'another' });
    assert.ok(!dms('frontend-1').some((m) => m.includes('ready for you')));
    bus.sweep(1, new Set(), Date.now() + 3_600_000);
    assert.ok(!bus.s.agents['frontend-1'].inactive);
  });

  test('server restart: workers recorded as running are marked exited', () => {
    bus.s.spawns = { 'frontend-1': { name: 'frontend-1', team: 'frontend', task: 1, status: 'running' } };
    const sp2 = new Spawner(bus, tasks, { repo, launcher: makeLauncher([]), env: {} });
    assert.equal(sp2.running().length, 0);
  });
});

describe('worker prompt and args', () => {
  test('prompt is short and self-contained', () => {
    const p = workerPrompt({ name: 'frontend-1', team: 'frontend', task: 3 });
    assert.ok(p.split('\n').length <= 6);
    assert.match(p, /bus join/);
    assert.match(p, /bus task take 3/);
    assert.match(p, /bus task done 3 --report/);
    assert.match(p, /stop/);
  });
  test('args: print mode, settings, permission mode; optional model and budget', () => {
    assert.deepEqual(workerArgs('P', 'S', {}), ['-p', 'P', '--settings', 'S', '--permission-mode', 'bypassPermissions']);
    const a = workerArgs('P', 'S', { BUS_WORKER_MODEL: 'sonnet', BUS_WORKER_BUDGET: '2', BUS_WORKER_PERMISSION: 'acceptEdits' });
    assert.deepEqual(a.slice(5), ['acceptEdits', '--model', 'sonnet', '--max-budget-usd', '2']);
  });
});
