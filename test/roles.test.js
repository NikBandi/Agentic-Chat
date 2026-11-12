// Team leads: one head (hot files, interfaces, requests, any team), one lead per team (its own team's tasks).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bus, BusError } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { bashBlockReason, isLeadSession } from '../src/hooks.js';

const PASS = 'node -e "process.exit(0)"';
let tmp, bus, tasks, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-roles-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function agent(name, team, role = '') {
  const dir = path.join(tmp, `wt${++n}`);
  fs.mkdirSync(dir);
  const a = bus.touch(name, team, dir, role);
  a.joinedAt = n;
  return a;
}
const dms = (name) => bus.s.messages.filter((m) => m.to === name && m.from === 'bus').map((m) => m.text);
const code = (fn, status, re) => assert.throws(fn, (e) => e instanceof BusError && (status === undefined || e.status === status) && (!re || re.test(e.message)));

beforeEach(() => {
  bus = new Bus(new Store(null));
  tasks = new Tasks(bus);
  agent('head', '', 'head');
  agent('fe-lead', 'frontend', 'lead');
  agent('be-lead', 'backend', 'lead');
  agent('fe-1', 'frontend');
  agent('be-1', 'backend');
});

describe('roles at join', () => {
  test('roles are recorded; the head defaults to its own team', () => {
    assert.equal(bus.roleOf('head'), 'head');
    assert.equal(bus.s.agents.head.team, 'head');
    assert.equal(bus.roleOf('fe-lead'), 'lead');
    assert.equal(bus.roleOf('fe-1'), 'worker');
    assert.equal(bus.roleOf('you'), 'human');
    assert.equal(bus.leadFor('frontend'), 'fe-lead');
    assert.equal(bus.leadFor('design'), 'head'); // no lead -> the head
    assert.ok(bus.who().find((a) => a.name === 'fe-lead').role === 'lead');
  });
  test('one head, one lead per team, a lead needs a team, bad roles refused', () => {
    code(() => bus.touch('head2', 'x', null, 'head'), 409, /already the head/);
    code(() => bus.touch('lead', '', null), 409, /already the head/); // the legacy lead is a head too
    code(() => bus.touch('fe-lead2', 'frontend', null, 'lead'), 409, /already leads team frontend/);
    code(() => bus.touch('x-lead', '', null, 'lead'), 400);
    code(() => bus.touch('boss', 'frontend', null, 'king'), 400, /bad role/);
  });
  test('roles are fixed at join; a lead cannot change team', () => {
    code(() => bus.touch('fe-1', 'frontend', null, 'lead'), 409, /registered as worker/);
    code(() => bus.touch('fe-lead', 'backend', null, 'lead'), 409, /leads team frontend/);
    assert.ok(bus.touch('fe-lead', 'frontend', null, 'lead')); // same role: fine
    assert.ok(bus.touch('fe-lead', '', null, '')); // no role header: fine
  });
  test('legacy single lead (no BUS_ROLE) still acts as the head', () => {
    bus = new Bus(new Store(null));
    tasks = new Tasks(bus);
    bus.touch('lead');
    bus.touch('w', 'fe', tmp);
    assert.equal(bus.roleOf('lead'), 'head');
    assert.equal(bus.headName(), 'lead');
    bus.hotAdd('lead', ['package.json']);
    assert.equal(bus.check('w', 'package.json').owner, 'lead');
  });
});

describe('the head owns shared files', () => {
  test('hot files, interfaces and requests: head/human only; leads are blocked like workers', () => {
    code(() => bus.hotAdd('fe-lead', ['package.json']), 403);
    code(() => bus.ifaceAdd('fe-lead', 'docs/CONTRACT.md', ['frontend']), 403);
    bus.hotAdd('head', ['package.json']);
    assert.deepEqual(bus.check('fe-lead', 'package.json'), { free: false, owner: 'head', claim: 'package.json', hot: true });
    assert.equal(bus.check('head', 'package.json').free, true);
    const r = bus.request('be-lead', 'netlify.toml', 'add functions dir');
    assert.match(dms('head').at(-1), /request r1 from be-lead — netlify\.toml/);
    code(() => bus.resolveRequest('fe-lead', r.id, 'done'), 403);
    bus.resolveRequest('head', r.id, 'done');
    assert.match(dms('be-lead').at(-1), /r1 \(netlify\.toml\) done/);
  });
});

describe('team leads plan their own team', () => {
  test("a lead's task belongs to its team and defaults to it", () => {
    const t = tasks.add('fe-lead', { title: 'tokens', check: PASS });
    assert.equal(t.team, 'frontend');
    assert.equal(t.assignee, 'frontend');
    assert.equal(t.by, 'fe-lead');
    assert.match(dms('fe-1').at(-1), new RegExp(`task #${t.id} ready`)); // offered to the free worker, not the lead
    assert.equal(dms('fe-lead').length, 0);
  });
  test('a lead cannot plan for another team or its members', () => {
    code(() => tasks.add('fe-lead', { title: 'x', check: PASS, team: 'backend' }), 403);
    code(() => tasks.add('fe-lead', { title: 'x', check: PASS, assignee: 'be-1' }), 403);
    code(() => tasks.add('fe-lead', { title: 'x', check: PASS, assignee: 'backend' }), 403);
    assert.equal(tasks.add('fe-lead', { title: 'x', check: PASS, assignee: 'fe-2' }).team, 'frontend'); // not joined yet: ok
  });
  test("a team's task can't be taken from another team", () => {
    const t = tasks.add('fe-lead', { title: 'x', check: PASS });
    code(() => tasks.take('be-1', t.id), 403, /for team frontend|assigned to frontend/);
    assert.equal(tasks.take('fe-1', t.id).owner, 'fe-1');
  });
  test('the head derives the team from the assignee, or takes --team', () => {
    assert.equal(tasks.add('head', { title: 'fe', check: PASS, assignee: 'fe-lead' }).team, 'frontend');
    assert.equal(tasks.add('head', { title: 'be', check: PASS, assignee: 'backend' }).team, 'backend');
    assert.equal(tasks.add('head', { title: 'q', check: PASS, team: 'qa' }).team, 'qa');
    assert.equal(tasks.add('head', { title: 'any', check: PASS }).team, null);
  });
});

describe('review and merge go to the right lead', () => {
  async function toReview(owner, task) {
    tasks.take(owner, task.id);
    const r = await tasks.done(owner, task.id, 'built it');
    assert.equal(r.ok, true);
    return r;
  }

  test("a worker's passing task goes to its team lead, who merges after approval", async () => {
    const t = tasks.add('fe-lead', { title: 'hero', check: PASS, assignee: 'fe-1' });
    const r = await toReview('fe-1', t);
    assert.equal(r.reviewer, 'fe-lead');
    assert.match(dms('fe-lead').at(-1), new RegExp(`#${t.id} passed its check`));
    assert.ok(!dms('head').some((m) => m.includes('passed its check')));
    assert.ok(!dms('be-lead').some((m) => m.includes('passed its check')));
    assert.match(tasks.report('fe-lead', t.id), /hero/);
    code(() => tasks.report('be-lead', t.id), 403);
    assert.ok(tasks.report('head', t.id));

    tasks.approve('you', t.id);
    assert.match(dms('fe-lead').at(-1), new RegExp(`#${t.id} approved — merge`));
    code(() => tasks.merged('be-lead', t.id, { force: true }), 403);
    code(() => tasks.merged('fe-1', t.id, { force: true }), 403);
    assert.equal((await tasks.merged('fe-lead', t.id, { force: true })).status, 'merged');
  });

  test("a lead's own task (the head's team-level task) is reviewed and merged by the head", async () => {
    const t = tasks.add('head', { title: 'Build the frontend', check: PASS, assignee: 'fe-lead' });
    assert.match(dms('fe-lead').at(-1), new RegExp(`task #${t.id} ready`)); // named assignee: offered even to a lead
    const r = await toReview('fe-lead', t);
    assert.equal(r.reviewer, 'head');
    assert.match(dms('head').at(-1), new RegExp(`#${t.id} passed its check`));
    tasks.approve('you', t.id);
    code(() => tasks.merged('fe-lead', t.id, { force: true }), 403); // can't sign off its own task
    assert.equal((await tasks.merged('head', t.id, { force: true })).status, 'merged');
  });

  test('team-level tasks are never auto-offered to leads', () => {
    bus = new Bus(new Store(null));
    tasks = new Tasks(bus);
    agent('head', '', 'head');
    agent('fe-lead', 'frontend', 'lead');
    tasks.add('head', { title: 'for the team', check: PASS, assignee: 'frontend' });
    assert.equal(dms('fe-lead').length, 0);
    agent('fe-1', 'frontend');
    assert.match(dms('fe-1').at(-1), /ready for you/);
  });

  test('reject notifies the owner and the reviewer (unless addressed in chat)', async () => {
    const t = tasks.add('fe-lead', { title: 'x', check: PASS, assignee: 'fe-1' });
    await toReview('fe-1', t);
    bus.send('you', '@fe-lead', `reject #${t.id} spacing is off`);
    assert.equal(bus.s.tasks[0].status, 'in_progress');
    assert.match(dms('fe-1').at(-1), /rejected: spacing is off/);
    assert.ok(!dms('fe-lead').some((m) => m.includes('rejected'))); // the human told fe-lead directly
    await tasks.done('fe-1', t.id);
    bus.send('you', '', `approve #${t.id}`);
    assert.equal(bus.s.tasks[0].status, 'approved');
  });

  test('reassign/drop: a lead only within its team; the head anywhere', () => {
    const t = tasks.add('fe-lead', { title: 'x', check: PASS, assignee: 'fe-1' });
    code(() => tasks.reassign('be-lead', t.id, 'be-1'), 403);
    code(() => tasks.reassign('fe-lead', t.id, 'be-1'), 403, /not on team frontend/);
    assert.equal(tasks.reassign('head', t.id, 'be-1').assignee, 'be-1');
    code(() => tasks.drop('be-lead', t.id), 403);
    assert.equal(tasks.drop('fe-lead', t.id).status, 'dropped');
  });
});

describe('inactivity goes to the team lead', () => {
  test('a silent worker is reported to its lead; a silent lead to the head; the head is never flagged', () => {
    const now = Date.now() + 3_600_000;
    bus.sweep(60_000, new Set(), now);
    assert.ok(dms('fe-lead').some((m) => /fe-1 inactive/.test(m)));
    assert.ok(dms('be-lead').some((m) => /be-1 inactive/.test(m)));
    assert.ok(dms('head').some((m) => /fe-lead inactive/.test(m)));
    assert.equal(bus.s.agents.head.inactive, undefined);
    code(() => bus.releaseOf('be-lead', 'fe-1', [], true), 403);
    assert.ok(bus.releaseOf('fe-lead', 'fe-1', [], true));
  });
});

describe('hooks', () => {
  test('lead sessions (may conclude merges) come from BUS_ROLE or the legacy name', () => {
    assert.equal(isLeadSession({ BUS_AGENT: 'fe-lead', BUS_ROLE: 'lead' }), true);
    assert.equal(isLeadSession({ BUS_AGENT: 'head', BUS_ROLE: 'head' }), true);
    assert.equal(isLeadSession({ BUS_AGENT: 'lead' }), true);
    assert.equal(isLeadSession({ BUS_AGENT: 'fe-1' }), false);
    assert.equal(isLeadSession({ BUS_AGENT: 'fe-1', BUS_ROLE: 'worker' }), false);
  });
  test('the shell guard blocks changing BUS_ROLE', () => {
    for (const c of ['BUS_ROLE=head git commit -m x', 'export BUS_ROLE=lead', 'unset BUS_ROLE', '$env:BUS_ROLE = "head"', 'env -u BUS_ROLE bus task merged 3']) {
      assert.ok(bashBlockReason(c), c);
    }
    assert.equal(bashBlockReason('echo $BUS_ROLE'), null);
  });
});
