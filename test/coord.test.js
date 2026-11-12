// Build step 7 (hot files, change requests, interface alerts, inactivity) + chat-approval strictness.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Bus } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';

let bus, tasks;
const inbox = (n) => bus.read(n).messages.map((m) => m.text);

beforeEach(() => {
  bus = new Bus(new Store(null));
  tasks = new Tasks(bus);
  bus.touch('lead');
  bus.touch('fe1', 'frontend');
  bus.touch('be1', 'backend');
  for (const n of ['lead', 'fe1', 'be1']) bus.read(n);
});

describe('hot files', () => {
  test('only lead/human manage them', () => {
    assert.throws(() => bus.hotAdd('fe1', ['package.json']), /only the head or the human/);
    assert.deepEqual(bus.hotAdd('lead', ['package.json', './package.json']), ['package.json']);
    assert.deepEqual(bus.hotRm('you', ['package.json']), []);
  });
  test('belong to the lead: blocked for workers in check and claim, free for the lead', () => {
    bus.hotAdd('lead', ['package.json', 'src/shared/']);
    assert.deepEqual(bus.check('fe1', 'package.json'), { free: false, owner: 'lead', claim: 'package.json', hot: true });
    assert.equal(bus.check('lead', 'src/shared/types.ts').free, true);
    const r = bus.claim('fe1', ['src/']);
    assert.equal(r.ok, false);
    assert.ok(r.conflicts.some((c) => c.hot && c.claim === 'src/shared/'));
  });
  test('a task whose files include a hot file cannot be taken by a worker', () => {
    bus.hotAdd('lead', ['package.json']);
    const t = tasks.add('lead', { title: 'deps', check: 'exit 0', files: ['package.json'], assignee: 'fe1' });
    assert.throws(() => tasks.take('fe1', t.id), /held by lead/);
  });
});

describe('change requests', () => {
  test('request -> lead DM -> done/decline -> requester DM', () => {
    const r = bus.request('fe1', 'package.json', 'add zod ^3');
    assert.match(inbox('lead')[0], /request r1 from fe1 — package\.json: add zod \^3/);
    assert.throws(() => bus.resolveRequest('fe1', r.id, 'done'), /only the head or the human/);
    bus.resolveRequest('lead', 'r1', 'decline', 'use valibot');
    assert.match(inbox('fe1')[0], /r1 \(package\.json\) declined: use valibot/);
    assert.throws(() => bus.resolveRequest('lead', 1, 'done'), /already declined/);
    assert.throws(() => bus.request('fe1', 'package.json', ''), /usage/);
  });
});

describe('interface alerts', () => {
  beforeEach(() => {
    bus.ifaceAdd('lead', 'src/types/', ['frontend', 'backend']);
    bus.claim('be1', ['src/types/']);
  });
  test('editing records a reminder for the other consuming teams only', () => {
    assert.equal(bus.check('be1', 'src/types/user.ts', { editing: true }).iface, 'src/types/');
    assert.deepEqual(bus.unannounced('be1'), [['src/types/', ['frontend']]]);
  });
  test('a plain check (not an edit) records nothing', () => {
    bus.check('be1', 'src/types/user.ts');
    assert.deepEqual(bus.unannounced('be1'), []);
  });
  test('notice shows the reminder once; announcing to the team clears it', () => {
    bus.check('be1', 'src/types/user.ts', { editing: true });
    assert.match(bus.notice('be1'), /changed interface src\/types\/ — announce it: bus send @frontend/);
    assert.equal(bus.notice('be1'), null);
    bus.send('be1', '#general', 'unrelated');
    assert.equal(bus.unannounced('be1').length, 1);
    bus.send('be1', '@frontend', 'User gained email');
    assert.deepEqual(bus.unannounced('be1'), []);
  });
  test('task done is refused until the change is announced', async () => {
    const t = tasks.add('lead', { title: 'types', check: 'exit 0', files: ['src/api/'], assignee: 'be1' });
    tasks.take('be1', t.id);
    bus.s.agents.be1.worktree = os.tmpdir();
    bus.check('be1', 'src/types/user.ts', { editing: true });
    await assert.rejects(tasks.done('be1', t.id), /announce your interface change first: bus send @frontend/);
    bus.send('be1', '#frontend', 'User type gained email');
    assert.equal((await tasks.done('be1', t.id)).ok, true);
  });
});

describe('inactivity', () => {
  test('flags silent agents once, tells the lead, skips busy waiters and the lead, clears on activity', () => {
    const now = Date.now() + 31 * 60_000;
    assert.deepEqual(bus.sweep(30 * 60_000, new Set(['be1']), now), ['fe1']);
    assert.match(inbox('lead').at(-1), /fe1 inactive 31m — bus release --of fe1 --all/);
    assert.deepEqual(bus.sweep(30 * 60_000, new Set(['be1']), now), []);
    bus.touch('fe1');
    assert.equal(bus.s.agents.fe1.inactive, false);
  });
  test('lead may release claims only of inactive agents; human always', () => {
    bus.claim('fe1', ['src/ui/']);
    assert.throws(() => bus.releaseOf('lead', 'fe1', [], true), /inactive/);
    assert.throws(() => bus.releaseOf('be1', 'fe1', [], true), /only the human/);
    bus.s.agents.fe1.inactive = true;
    assert.equal(bus.releaseOf('lead', 'fe1', [], true).released, 1);
    bus.claim('be1', ['src/api/']);
    assert.equal(bus.releaseOf('you', 'be1', [], true).released, 1);
  });
});

describe('chat approvals are whole-message commands', () => {
  let t;
  beforeEach(async () => {
    t = tasks.add('lead', { title: 'x', check: 'exit 0', assignee: 'fe1' });
    tasks.take('fe1', t.id);
    bus.s.agents.fe1.worktree = os.tmpdir();
    await tasks.done('fe1', t.id);
  });
  for (const text of [`don't approve #1`, `I'll approve #1 later`, `approve #1 and #2`]) {
    test(`ignored: "${text}"`, () => {
      bus.send('you', '@lead', text);
      assert.equal(tasks.get(t.id).status, 'review');
    });
  }
  for (const text of ['approve #1', '@lead approve #1', 'Approve #1.']) {
    test(`applied: "${text}"`, () => {
      bus.send('you', text.startsWith('@') ? '#general' : '@lead', text);
      assert.equal(tasks.get(t.id).status, 'approved');
    });
  }
  test('reject with reason', () => {
    bus.send('you', '@lead', 'reject #1: needs tests');
    assert.equal(tasks.get(t.id).status, 'in_progress');
    assert.match(inbox('fe1').at(-1), /#1 rejected: needs tests/);
  });
});

describe('dropping a dependency', () => {
  test('human drop warns the lead about now-blocked dependents and clears owner', () => {
    const a = tasks.add('lead', { title: 'a', check: 'exit 0', assignee: 'fe1' });
    const b = tasks.add('lead', { title: 'b', check: 'exit 0', after: [a.id] });
    tasks.take('fe1', a.id);
    bus.read('lead');
    tasks.drop('you', a.id);
    assert.equal(tasks.get(a.id).owner, null);
    assert.match(inbox('lead').at(-1), new RegExp(`#${a.id} dropped — #${b.id} depend on it`));
  });
});
