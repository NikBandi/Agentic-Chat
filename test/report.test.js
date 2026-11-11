// Agent reports: the 3-line --report limit, the bus-built summary, storage, `bus report`, and inbox isolation.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bus, BusError } from '../src/bus.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { createServer } from '../src/server.js';
import { parseReport, messageSummary, fmtDuration, REPORT_MAX_CHARS } from '../src/report.js';
import { AGENT_RULES } from '../src/init.js';

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(3)"';
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-report-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('--report: at most 3 short lines', () => {
  test('0 to 3 lines are fine; blank lines and surrounding space are dropped', () => {
    assert.deepEqual(parseReport(''), []);
    assert.deepEqual(parseReport(undefined), []);
    assert.deepEqual(parseReport('built the list endpoint'), ['built the list endpoint']);
    assert.deepEqual(parseReport('built X\n\n  problems: none  \nunfinished: paging\n'), ['built X', 'problems: none', 'unfinished: paging']);
  });
  test('a literal "\\n" separates lines too (shell-friendly)', () => {
    assert.deepEqual(parseReport('built X\\nproblems: none\\nunfinished: -'), ['built X', 'problems: none', 'unfinished: -']);
  });
  test('4 lines are refused with a one-line reason', () => {
    assert.throws(() => parseReport('a\nb\nc\nd'), (e) => e instanceof BusError && e.message === '--report takes at most 3 lines (got 4)');
    assert.throws(() => parseReport('a\\nb\\nc\\nd\\ne'), /got 5/);
  });
  test('a line over the length limit is refused and named', () => {
    assert.doesNotThrow(() => parseReport('x'.repeat(REPORT_MAX_CHARS)));
    assert.throws(() => parseReport('ok\n' + 'x'.repeat(REPORT_MAX_CHARS + 1)), { message: `--report line 2 is too long (max ${REPORT_MAX_CHARS} chars)` });
  });
  test('the agent rule asks for it', () => {
    assert.match(AGENT_RULES, /On bus task done, include --report with up to 3 lines\./);
  });
});

describe('building the report', () => {
  test('fmtDuration', () => {
    assert.equal(fmtDuration(42_000), '42s');
    assert.equal(fmtDuration(42 * 60_000), '42m');
    assert.equal(fmtDuration(65 * 60_000), '1h 05m');
  });

  test('messages grouped by counterpart: ↔ both ways, → sent only, ← received only; window and system notices respected', () => {
    const bus = new Bus(new Store(null));
    bus.touch('fe1', 'frontend'); bus.touch('be1', 'backend'); bus.touch('lead');
    const since = Date.now() - 1000;
    const old = bus.send('be1', '@fe1', 'before the task'); old.ts = since - 5000; // outside the window
    for (let i = 0; i < 4; i++) bus.send('fe1', '@be1', `q${i}`);
    for (let i = 0; i < 3; i++) bus.send('be1', '@fe1', `a${i}`);
    bus.send('fe1', '@lead', 'status'); bus.send('fe1', '@lead', 'done soon');
    bus.send('fe1', '#frontend', 'fyi');
    bus.send('you', '#general', '@frontend heads up'); // team mention = received
    bus.send('be1', '#general', 'chatter not for fe1');
    bus.notify('fe1', 'task #1 ready for you'); // system notice: not counted
    const s = messageSummary(bus.s.messages, bus.s.agents.fe1, since, Date.now() + 1, (m, a) => bus.isFor(m, a));
    assert.equal(s, '↔ be1: 4 sent, 3 received; → lead: 2; → #frontend: 1; ← you: 1');
    assert.equal(messageSummary([], bus.s.agents.fe1, 0, Date.now(), () => false), 'none');
  });

  describe('through bus task done', () => {
    let bus, tasks, reportsFile, wt;
    beforeEach(() => {
      bus = new Bus(new Store(null));
      reportsFile = path.join(tmp, `reports-${Math.random().toString(36).slice(2)}.md`);
      tasks = new Tasks(bus, { repo: tmp, reportsFile });
      bus.touch('lead');
      wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
      bus.touch('fe1', 'frontend', wt);
      bus.touch('be1', 'backend');
    });

    async function finished(notes = 'built the list endpoint\nproblems: flaky fixture, fixed\nunfinished: pagination') {
      const t = tasks.add('lead', { title: 'Users API', check: FAIL, files: ['src/api/', 'src/types/user.ts'], assignee: 'fe1' });
      tasks.take('fe1', t.id);
      t.takenAt = Date.now() - 42 * 60_000;
      bus.send('fe1', '@be1', 'what shape?'); bus.send('be1', '@fe1', '{id,name}'); bus.send('fe1', '@lead', 'almost');
      assert.equal((await tasks.done('fe1', t.id)).ok, false); // run 1: fails
      t.check = PASS;
      const r = await tasks.done('fe1', t.id, 'list endpoint', { report: notes }); // run 2: passes
      assert.equal(r.ok, true);
      return tasks.get(t.id);
    }

    test('the bus fills in agent, role, team, time, files, commit, check runs and messages; the agent adds its 3 lines', async () => {
      const t = await finished();
      const lines = t.report.text.split('\n');
      assert.equal(lines[0], `#${t.id} Users API — fe1 (worker, team frontend)`);
      assert.match(lines[1], /^time: 42m \(\d{4}-\d\d-\d\d \d\d:\d\dZ → \d{4}-\d\d-\d\d \d\d:\d\dZ\)$/);
      assert.equal(lines[2], 'files claimed: src/api/, src/types/user.ts');
      assert.equal(lines[3], 'commit: none recorded'); // plain dir, not a git worktree
      assert.match(lines[4], /^checks: 2 runs \(1 failed\), final: passed in \d+\.\ds$/);
      assert.equal(lines[5], 'messages: ↔ be1: 1 sent, 1 received; → lead: 1');
      assert.deepEqual(lines.slice(6), ['notes:', '  built the list endpoint', '  problems: flaky fixture, fixed', '  unfinished: pagination']);
    });
    test('no --report still yields the bus-built report', async () => {
      const t = await finished('');
      assert.match(t.report.text, /\nnotes:\n {2}\(none given\)$/);
    });
    test('a 4-line --report is refused before the check runs (no run counted, task untouched)', async () => {
      const t = tasks.add('lead', { title: 'x', check: PASS, assignee: 'fe1' });
      tasks.take('fe1', t.id);
      await assert.rejects(tasks.done('fe1', t.id, '', { report: 'a\nb\nc\nd' }), /at most 3 lines \(got 4\)/);
      assert.equal(tasks.get(t.id).checkRuns, 0);
      assert.equal(tasks.get(t.id).status, 'in_progress');
      assert.equal(tasks.get(t.id).result, null);
    });
    test('stored on the task and appended to reports.md (markdown), once per passing done', async () => {
      const t = await finished();
      const md = fs.readFileSync(reportsFile, 'utf8');
      assert.match(md, new RegExp(`^## #${t.id} Users API — fe1 \\(worker, team frontend\\)\\n\\n- \\*\\*time:\\*\\* 42m`));
      assert.match(md, /- \*\*notes:\*\*\n {2}- built the list endpoint\n/);
      assert.equal(md.match(/^## /gm).length, 1);
    });
    test('reports never reach agent inboxes; the lead only gets a pointer', async () => {
      const t = await finished();
      const toAgents = bus.s.messages.filter((m) => m.from === 'bus');
      for (const m of toAgents) {
        assert.ok(!m.text.includes('built the list endpoint'), `report text leaked into a DM to ${m.to}`);
        assert.ok(!m.text.includes('files claimed'), `report text leaked into a DM to ${m.to}`);
      }
      assert.match(toAgents.filter((m) => m.to === 'lead').at(-1).text, new RegExp(`review \\(bus report ${t.id}\\), then ask @you to approve$`));
    });
    test('bus report: lead and human only', async () => {
      const t = await finished();
      assert.equal(tasks.report('lead', t.id), t.report.text);
      assert.equal(tasks.report('you', t.id), t.report.text);
      assert.throws(() => tasks.report('fe1', t.id), { status: 403 });
      const other = tasks.add('lead', { title: 'y', check: PASS });
      assert.throws(() => tasks.report('lead', other.id), { status: 404, message: `#${other.id} has no report yet — one is written when its done-check passes` });
    });
  });

  test('server: reports.md sits next to the state file; GET /api/task/report enforces roles', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'srv-'));
    const srv = createServer({ port: 0, dataFile: path.join(dir, 'state.json') });
    const port = await srv.listen();
    try {
      srv.bus.touch('lead');
      srv.bus.touch('fe1', 'frontend', dir);
      const t = srv.tasks.add('lead', { title: 'z', check: PASS, assignee: 'fe1' });
      srv.tasks.take('fe1', t.id);
      await srv.tasks.done('fe1', t.id, '', { report: 'did z' });
      assert.match(fs.readFileSync(path.join(dir, 'reports.md'), 'utf8'), /## #1 z — fe1/);
      const get = (agent) => fetch(`http://127.0.0.1:${port}/api/task/report?id=1`, { headers: agent ? { 'x-bus-agent': agent } : {} });
      const lead = await get('lead');
      assert.equal(lead.status, 200);
      assert.match((await lead.json()).report, /^#1 z — fe1 \(worker, team frontend\)/);
      assert.equal((await get('fe1')).status, 403);
      assert.equal((await get()).status, 200); // the human (BUS_AUTH off)
    } finally { await srv.close(); }
  });
});
