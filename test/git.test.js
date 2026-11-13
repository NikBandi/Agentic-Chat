// Git workflow: done refuses uncommitted work, records the commit; merged verifies it reached the main branch.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bus } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { uncommitted, headSha, mainBranch, isAncestor } from '../src/check.js';

const PASS = 'node -e "process.exit(0)"';
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
const skip = !hasGit && 'git not installed';

const g = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

let tmp, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-git-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Fresh repo whose only branch is `branch`, with one commit. */
function repo(branch = 'main') {
  const d = path.join(tmp, `r${++n}`);
  fs.mkdirSync(d);
  g(d, 'init', '-q');
  g(d, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  g(d, 'add', '.'); g(d, 'commit', '-q', '-m', 'init');
  return d;
}

/** Main repo + a worker worktree on branch "feat" (shared refs, like any git worktree). */
function setup(branch = 'main') {
  const main = repo(branch);
  const wt = path.join(tmp, `wt${n}`);
  g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  const bus = new Bus(new Store(null));
  const tasks = new Tasks(bus, { repo: main });
  bus.touch('lead');
  bus.touch('fe1', 'frontend', wt);
  const t = tasks.add('lead', { title: 'x', check: PASS, assignee: 'fe1' });
  tasks.take('fe1', t.id);
  return { main, wt, bus, tasks, t };
}
const commit = (wt, file = 'b.txt') => { fs.writeFileSync(path.join(wt, file), file); g(wt, 'add', '.'); g(wt, 'commit', '-q', '-m', file); return g(wt, 'rev-parse', 'HEAD'); };

describe('git helpers', { skip }, () => {
  test('uncommitted counts changed + untracked files, ignores .bus/, null outside a repo', async () => {
    const d = repo();
    assert.equal(await uncommitted(d), 0);
    fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(d, 'new.txt'), 'x');
    fs.mkdirSync(path.join(d, '.bus'));
    fs.writeFileSync(path.join(d, '.bus', 'state.json'), '{}');
    assert.equal(await uncommitted(d), 2);
    const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
    assert.equal(await uncommitted(plain), null);
    assert.equal(await headSha(plain), null);
  });
  test('mainBranch: BUS_MAIN, else main, else master', async () => {
    const saved = process.env.BUS_MAIN;
    try {
      delete process.env.BUS_MAIN;
      assert.equal(await mainBranch(repo('main')), 'main');
      assert.equal(await mainBranch(repo('master')), 'master');
      process.env.BUS_MAIN = 'trunk';
      assert.equal(await mainBranch(repo('master')), 'trunk');
    } finally { if (saved === undefined) delete process.env.BUS_MAIN; else process.env.BUS_MAIN = saved; }
  });
  test('isAncestor: in / not in / error', async () => {
    const d = repo();
    const sha = g(d, 'rev-parse', 'HEAD');
    assert.deepEqual(await isAncestor(sha, 'main', d), { in: true });
    g(d, 'checkout', '-q', '-b', 'feat');
    const b = commit(d);
    assert.deepEqual(await isAncestor(b, 'main', d), { in: false });
    assert.ok((await isAncestor('f'.repeat(40), 'main', d)).err);
  });
});

describe('task done needs committed work', { skip }, () => {
  test('refuses with the file count, before running the check', async () => {
    const { wt, tasks, t } = setup();
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'edited');
    tasks.get(t.id).check = 'node -e "require(\'fs\').writeFileSync(\'ran\',\'\')"';
    await assert.rejects(tasks.done('fe1', t.id), { message: 'commit your changes first (2 files uncommitted)', status: 409 });
    assert.equal(fs.existsSync(path.join(wt, 'ran')), false);
    assert.equal(tasks.get(t.id).status, 'in_progress');
    assert.equal(tasks.running.size, 0);
    g(wt, 'checkout', '-q', 'a.txt');
    await assert.rejects(tasks.done('fe1', t.id), /\(1 file uncommitted\)/);
  });
  test('--allow-dirty skips the refusal', async () => {
    const { wt, tasks, t } = setup();
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
    assert.equal((await tasks.done('fe1', t.id, '', { allowDirty: true })).ok, true);
  });
  test('records the HEAD commit on the task and the merge request', async () => {
    const { wt, bus, tasks, t } = setup();
    const sha = commit(wt);
    const r = await tasks.done('fe1', t.id, 'did it');
    assert.equal(r.ok, true);
    assert.equal(r.mr.commit, sha);
    assert.equal(r.mr.branch, 'feat');
    assert.equal(tasks.get(t.id).commit, sha);
    assert.equal(bus.s.mergeRequests[0].commit, sha);
  });
  test('a worktree that is not a git repo is not checked and records no commit', async () => {
    const bus = new Bus(new Store(null));
    const tasks = new Tasks(bus, { repo: tmp });
    const plain = path.join(tmp, `plain${++n}`); fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'x'), 'x');
    bus.touch('lead'); bus.touch('fe1', 'frontend', plain);
    const t = tasks.add('lead', { title: 'x', check: PASS, assignee: 'fe1' });
    tasks.take('fe1', t.id);
    assert.equal((await tasks.done('fe1', t.id)).ok, true);
    assert.equal(tasks.get(t.id).commit, null);
    tasks.approve('you', t.id);
    assert.equal((await tasks.merged('lead', t.id)).status, 'merged');
  });
});

describe('task merged verifies the commit is in main', { skip }, () => {
  let saved;
  beforeEach(() => { saved = process.env.BUS_MAIN; delete process.env.BUS_MAIN; });
  afterEach(() => { if (saved === undefined) delete process.env.BUS_MAIN; else process.env.BUS_MAIN = saved; });

  async function approved(branch) {
    const s = setup(branch);
    s.sha = commit(s.wt);
    await s.tasks.done('fe1', s.t.id);
    s.tasks.approve('you', s.t.id);
    return s;
  }

  test('refuses until the branch is merged into main, then completes', async () => {
    const { main, tasks, t, sha, bus } = await approved();
    const s7 = sha.slice(0, 7);
    await assert.rejects(tasks.merged('lead', t.id),
      { message: `${s7} is not in main yet — merge it first with plain git merge ${s7} (no squash or rebase)`, status: 409 });
    assert.equal(tasks.get(t.id).status, 'approved');
    assert.equal(bus.s.agents.fe1.task, t.id);
    g(main, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    assert.equal((await tasks.merged('lead', t.id)).status, 'merged');
    assert.equal(bus.s.agents.fe1.task, null);
  });
  test('falls back to master when main does not exist', async () => {
    const { tasks, t, sha } = await approved('master');
    await assert.rejects(tasks.merged('lead', t.id), { message: new RegExp(`^${sha.slice(0, 7)} is not in master yet — merge it first`) });
  });
  test('approval notice names the reviewed commit, not the branch', async () => {
    const { bus, t, sha } = await approved();
    const note = bus.s.messages.filter((m) => m.to === 'lead').at(-1).text;
    assert.equal(note, `#${t.id} approved — merge ${sha.slice(0, 7)} (git merge ${sha.slice(0, 7)}; not the branch), then: bus task merged ${t.id}`);
    assert.ok(!note.includes('feat'));
  });
  test('merging the reviewed sha passes even if the branch moved on after approval', async () => {
    const { main, wt, tasks, t, sha } = await approved();
    const late = commit(wt, 'late.txt'); // unreviewed commit added after approval
    g(main, 'merge', '-q', '--no-ff', '-m', 'm', sha.slice(0, 7));
    assert.equal((await tasks.merged('lead', t.id)).status, 'merged');
    assert.throws(() => g(main, 'merge-base', '--is-ancestor', late, 'main')); // the late commit stayed out of main
  });
  test('a squash merge is refused: the reviewed commit is not an ancestor of main', async () => {
    const { main, tasks, t } = await approved();
    g(main, 'merge', '-q', '--squash', 'feat'); g(main, 'commit', '-q', '-m', 'squashed');
    await assert.rejects(tasks.merged('lead', t.id), { message: /no squash or rebase/ });
  });
  test('BUS_MAIN names the main branch', async () => {
    const { main, tasks, t } = await approved();
    process.env.BUS_MAIN = 'release';
    g(main, 'branch', 'release', 'feat');
    assert.equal((await tasks.merged('lead', t.id)).status, 'merged');
  });
  test("prefers the lead's worktree over the server repo", async () => {
    const { main, bus, tasks, t } = await approved();
    bus.touch('lead', null, path.join(tmp, 'nowhere'));
    await assert.rejects(tasks.merged('lead', t.id), { message: /^can't verify [0-9a-f]{7} in main: .+ — merge it, or use --force$/ });
    bus.s.agents.lead.worktree = main;
    g(main, 'merge', '-q', '--no-ff', '-m', 'm', 'feat');
    assert.equal((await tasks.merged('lead', t.id)).status, 'merged');
  });
  test('--force skips verification (and is logged); permissions still apply synchronously', async () => {
    const { bus, tasks, t, sha } = await approved();
    assert.throws(() => tasks.merged('fe1', t.id, { force: true }), { status: 403 });
    assert.equal((await tasks.merged('lead', t.id, { force: true })).status, 'merged');
    assert.ok(bus.s.activity.some((e) => e.text.includes(`--force (${sha.slice(0, 7)} unverified)`)));
  });
  test('reassign clears the recorded commit', async () => {
    const { bus, tasks, t } = await approved();
    bus.touch('fe2', 'frontend', tmp);
    tasks.reassign('lead', t.id, 'fe2');
    assert.equal(tasks.get(t.id).commit, null);
  });
});
