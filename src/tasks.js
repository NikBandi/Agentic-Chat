// Tasks: dependencies, take (claims files), done-checks, merge requests, approval, merge, auto-handoff.
// Lifecycle: open -> in_progress -> review -> approved -> merged      (+ dropped; reject: review -> in_progress)
import { BusError, HUMAN, cleanName, fmtUsage } from './bus.js';
import { normPath } from './paths.js';
import fs from 'node:fs';
import path from 'node:path';
import { runCheck, currentBranch, uncommitted, headSha, mainBranch, isAncestor } from './check.js';
import { parseReport, buildReport, render } from './report.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const num = (id) => Number(String(id ?? '').replace(/^#/, ''));
const short = (sha) => String(sha).slice(0, 7);

export class Tasks {
  /** repo: where merges are verified when the lead's worktree is unknown (the dir the server started in). */
  /** reportsFile: markdown file each passing task's report is appended to (null: don't write one). */
  constructor(bus, { repo = process.cwd(), reportsFile = null } = {}) {
    this.bus = bus;
    this.repo = repo;
    this.reportsFile = reportsFile;
    this.s = bus.s;
    this.s.taskSeq ??= this.s.tasks.reduce((m, t) => Math.max(m, t.id), 0);
    this.running = new Set();
    bus.on('join', (a) => this.offerNext(a.name));
    bus.on('message', (m) => { if (m.from === HUMAN) this.#chatApproval(m); });
  }

  get(id) {
    const t = this.s.tasks.find((x) => x.id === num(id));
    if (!t) throw new BusError(`no task ${id}`, 404);
    return t;
  }

  #mr(t) { return this.s.mergeRequests.find((m) => m.task === t.id); }
  #touch(t) { t.updatedAt = Date.now(); this.bus.store.save(); }
  depsMet(t) { return t.after.every((d) => this.s.tasks.find((x) => x.id === d)?.status === 'merged'); }
  #mayTake(t, a) {
    if (t.team && a.team !== t.team && t.assignee !== a.name) return false; // a team's tasks stay in that team
    return !t.assignee || t.assignee === a.name || t.assignee === a.team;
  }
  /** Leads and the head never get tasks offered automatically (they take one only when it names them). */
  #autoOffer(a) { return this.bus.roleOf(a.name) === 'worker' && !a.spawned; } // spawned workers do only the task they were started for
  /** Who reviews and merges #t: its team's lead, or the head (also when the lead owns the task itself). */
  reviewer(t) {
    const r = this.bus.leadFor(t.team);
    return r === t.owner ? this.bus.headName() : r;
  }
  #needBoss(who, t, what) {
    const ok = this.bus.isBossOf(who, t.team) && (this.bus.isTop(who) || t.owner !== who); // a lead can't sign off its own task
    if (!ok) throw new BusError(`only ${this.reviewer(t)}, the head or the human can ${what} #${t.id}`, 403);
  }

  add(who, { title, brief = '', files = [], context = [], check, after = [], assignee, team, timeout } = {}) {
    if (!this.bus.isBoss(who)) throw new BusError('only a lead, the head or the human can add tasks', 403);
    title = String(title ?? '').trim();
    if (!title) throw new BusError('task needs a title');
    check = String(check ?? '').trim();
    if (!check) throw new BusError('task needs a done-check: --check "cmd"');
    const deps = [...new Set(after.map(num))];
    for (const d of deps) this.get(d);
    assignee = cleanName(assignee) || null;
    if (assignee && !NAME_RE.test(assignee)) throw new BusError(`bad assignee "${assignee}"`);
    team = cleanName(team) || null;
    if (team && !NAME_RE.test(team)) throw new BusError(`bad team "${team}"`);
    if (!this.bus.isTop(who)) { // a team lead plans only for its own team
      const mine = this.s.agents[cleanName(who)].team;
      if (team && team !== mine) throw new BusError(`you lead team ${mine}, not ${team}`, 403);
      const other = assignee && this.s.agents[assignee];
      if (other && other.team !== mine) throw new BusError(`${assignee} is on team ${other.team}, not ${mine}`, 403);
      if (assignee && !other && assignee in this.s.teams && assignee !== mine) throw new BusError(`you lead team ${mine}, not ${assignee}`, 403);
      team = mine;
      assignee ||= mine;
    } else if (!team && assignee) team = this.s.agents[assignee]?.team ?? (assignee in this.s.teams ? assignee : null);
    const now = Date.now();
    const t = {
      id: ++this.s.taskSeq, title, brief: String(brief), files: [...new Set(files.map(normPath).filter(Boolean))],
      context: [...new Set((context ?? []).map(normPath).filter(Boolean))], // files to read first, chosen by the lead
      check, after: deps, assignee, team, by: cleanName(who), status: 'open', owner: null, offered: [],
      timeout: Math.min(Math.max(1, Number(timeout) || 600), 3600), result: null, summary: '', branch: null, commit: null,
      createdAt: now, updatedAt: now,
    };
    this.s.tasks.push(t);
    this.bus.log(`task #${t.id} added by ${t.by}: ${t.title}${assignee ? ' for ' + assignee : ''}`);
    this.offer(t);
    this.#touch(t);
    return t;
  }

  /** DM one suitable free agent (or the named assignee) that this task is ready. */
  offer(t, prefix = '') {
    if (t.status !== 'open' || !this.depsMet(t)) return;
    const agents = Object.values(this.s.agents);
    let target = null;
    if (t.assignee && this.s.agents[t.assignee]) target = t.assignee; // a specific agent (busy or not)
    else {
      const free = agents
        .filter((a) => !a.task && this.#autoOffer(a) && this.#mayTake(t, a) && !t.offered.includes(a.name))
        .sort((x, y) => x.joinedAt - y.joinedAt);
      target = free[0]?.name ?? null;
    }
    if (!target || t.offered.includes(target)) return;
    t.offered.push(target);
    this.bus.notify(target, `${prefix}task #${t.id} ready for you: ${t.title} — bus task take ${t.id}`);
  }

  /** After an agent frees up (join, merge, reassign), offer it the next task it may take. */
  offerNext(name) {
    const a = this.s.agents[name];
    if (!a || a.task || !this.#autoOffer(a)) return;
    const t = this.s.tasks.find((x) => x.status === 'open' && this.depsMet(x) && this.#mayTake(x, a) && !x.offered.includes(a.name));
    if (!t) return;
    t.offered.push(a.name);
    this.bus.notify(a.name, `task #${t.id} ready for you: ${t.title} — bus task take ${t.id}`);
    this.#touch(t);
  }

  list(who, mine = false) {
    const a = this.s.agents[who];
    if (!mine) return this.s.tasks;
    return this.s.tasks.filter((t) => t.owner === who || (a && t.status === 'open' && this.depsMet(t) && this.#mayTake(t, a)));
  }

  take(who, id) {
    const a = this.s.agents[who];
    if (!a) throw new BusError('only a registered agent can take tasks — run: bus join', 400);
    const t = this.get(id);
    if (t.owner === who && t.status === 'in_progress') return t;
    if (t.status !== 'open') throw new BusError(`#${t.id} is ${t.status}${t.owner ? ' (' + t.owner + ')' : ''}`, 409);
    if (!this.depsMet(t)) {
      const wait = t.after.filter((d) => this.get(d).status !== 'merged').map((d) => '#' + d).join(',');
      throw new BusError(`#${t.id} waits on ${wait} — you'll be told when it's ready`, 409);
    }
    if (!this.#mayTake(t, a)) throw new BusError(`#${t.id} is ${t.assignee ? 'assigned to ' + t.assignee : 'for team ' + t.team}`, 403);
    if (a.task && a.task !== t.id) throw new BusError(`finish #${a.task} first (one task at a time)`, 409);
    if (t.files.length) {
      const r = this.bus.claim(who, t.files, `task #${t.id}`);
      if (!r.ok) {
        const c = r.conflicts.map((x) => `${x.path} (held by ${x.owner})`).join(', ');
        throw new BusError(`can't claim ${c} — ask the owner or @${this.reviewer(t)}`, 409);
      }
    }
    Object.assign(t, { owner: who, status: 'in_progress', takenAt: Date.now(), checkRuns: 0, checkFails: 0 });
    a.task = t.id;
    this.bus.log(`${who} took #${t.id}`);
    this.#touch(t);
    return t;
  }

  /** Runs the done-check in the owner's worktree (which must be committed). Pass -> merge request for its reviewer. */
  async done(who, id, summary = '', { allowDirty = false, report = '' } = {}) {
    const t = this.get(id);
    if (t.owner !== who) throw new BusError(`#${t.id} is not yours`, 403);
    if (t.status !== 'in_progress') throw new BusError(`#${t.id} is ${t.status}`, 409);
    const notes = parseReport(report); // refuse a bad --report before spending a check run
    if (this.running.has(t.id)) throw new BusError(`#${t.id} check already running`, 409);
    const a = this.s.agents[who];
    if (!a.worktree) throw new BusError('worktree unknown — run bus join from your worktree', 400);
    const owed = this.bus.unannounced(who);
    if (owed.length) {
      const [p, teams] = owed[0];
      throw new BusError(`announce your interface change first: bus send ${teams.map((x) => '@' + x).join(' ')} "<what changed in ${p}>"`, 409);
    }
    this.running.add(t.id);
    let r, commit;
    try {
      if (!allowDirty) {
        const n = await uncommitted(a.worktree); // null: not a git worktree, nothing to enforce
        if (n) throw new BusError(`commit your changes first (${n} file${n === 1 ? '' : 's'} uncommitted)`, 409);
      }
      commit = await headSha(a.worktree); // the commit the check runs against
      r = await runCheck(t.check, a.worktree, t.timeout);
      t.checkRuns = (t.checkRuns ?? 0) + 1;
      if (!r.ok) t.checkFails = (t.checkFails ?? 0) + 1;
    } finally { this.running.delete(t.id); }
    t.result = { ok: r.ok, code: r.code, output: r.output, ms: r.ms, ts: Date.now() };
    if (t.status !== 'in_progress' || t.owner !== who) { this.#touch(t); throw new BusError(`#${t.id} changed while the check ran (${t.status})`, 409); }
    if (!r.ok) {
      this.bus.log(`#${t.id} check failed (${who})`);
      this.#touch(t);
      return { ok: false, code: r.code, output: r.output };
    }
    t.branch = await currentBranch(a.worktree);
    t.commit = commit;
    t.summary = String(summary || '').trim();
    t.status = 'review';
    const mr = { task: t.id, agent: who, branch: t.branch, commit: t.commit, summary: t.summary, status: 'pending', reason: '', ts: Date.now() };
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    this.s.mergeRequests.push(mr);
    this.#report(t, a, notes);
    this.bus.log(`#${t.id} passed its check — merge request from ${who}`);
    this.bus.notify(this.reviewer(t), `#${t.id} passed its check (${who}, branch ${t.branch ?? '?'})${t.summary ? ': ' + t.summary : ''} — review (bus report ${t.id}), then ask @you to approve`);
    this.#touch(t);
    return { ok: true, mr, reviewer: this.reviewer(t) };
  }

  /** Build the report from the bus's own records (no agent tokens), store it, append it to reports.md. Never sent to inboxes. */
  #report(t, a, notes) {
    const rep = buildReport({
      task: t, agent: a, notes,
      claims: this.bus.claims(a.name).map((c) => c.path),
      messages: this.s.messages,
      isFor: (m, ag) => this.bus.isFor(m, ag),
    });
    t.report = { ...rep, text: render(rep) };
    if (!this.reportsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.reportsFile), { recursive: true });
      fs.appendFileSync(this.reportsFile, render(rep, { md: true }) + '\n');
    } catch (e) { this.bus.log(`couldn't append report for #${t.id}: ${e.message}`); }
  }

  /** The stored report text: the task's lead, the head or the human. */
  report(who, id) {
    const t = this.get(id);
    if (!this.bus.isBossOf(who, t.team)) throw new BusError(`only ${this.reviewer(t)}, the head or the human can read #${t.id}'s report`, 403);
    if (!t.report) throw new BusError(`#${t.id} has no report yet — one is written when its done-check passes`, 404);
    return t.report.text + (t.usage ? `\n${fmtUsage(t.usage)}` : ''); // usage keeps growing after the report is built
  }

  approve(who, id) {
    if (who !== HUMAN) throw new BusError('only the human approves merges', 403);
    const t = this.get(id);
    if (t.status !== 'review') throw new BusError(`#${t.id} is ${t.status}, not awaiting approval`, 409);
    t.status = 'approved';
    Object.assign(this.#mr(t), { status: 'approved' });
    this.bus.log(`#${t.id} approved`);
    // Name the reviewed commit, not the branch: commits added to the branch after approval must not ride along.
    const what = t.commit ? `${short(t.commit)} (git merge ${short(t.commit)}; not the branch)` : (t.branch ?? 'its branch');
    this.bus.notify(this.reviewer(t), `#${t.id} approved — merge ${what}, then: bus task merged ${t.id}`);
    this.#touch(t);
    return t;
  }

  reject(who, id, why = '', { seen = [] } = {}) {
    if (who !== HUMAN) throw new BusError('only the human rejects merges', 403);
    const t = this.get(id);
    if (!['review', 'approved'].includes(t.status)) throw new BusError(`#${t.id} is ${t.status}, nothing to reject`, 409);
    why = String(why || '').trim() || 'no reason given';
    t.status = 'in_progress';
    Object.assign(this.#mr(t), { status: 'rejected', reason: why });
    this.bus.log(`#${t.id} rejected: ${why}`);
    this.bus.emit('task', { type: 'rejected', task: t, why });
    this.bus.notify(t.owner, `#${t.id} rejected: ${why} — fix it, then: bus task done ${t.id}`);
    const rev = this.reviewer(t);
    if (!seen.includes(rev)) this.bus.notify(rev, `#${t.id} rejected: ${why}`);
    this.#touch(t);
    return t;
  }

  /**
   * Lead reports the branch is merged: verify the recorded commit is in the main branch, then release claims,
   * hand off to dependents, free the owner. Permission/state errors throw synchronously; returns a Promise of the task.
   * force skips the git verification. Tasks with no recorded commit (not a git worktree) aren't verified.
   */
  merged(who, id, { force = false } = {}) {
    const t = this.get(id);
    this.#needBoss(who, t, 'mark merged');
    if (t.status !== 'approved') throw new BusError(`#${t.id} is ${t.status} — it needs human approval first`, 409);
    if (!t.commit || force) {
      if (t.commit) this.bus.log(`#${t.id} marked merged with --force (${short(t.commit)} unverified)`);
      return Promise.resolve(this.#finishMerge(t));
    }
    return this.#verifyMerge(t, who);
  }

  async #verifyMerge(t, who) {
    const dir = this.s.agents[who]?.worktree || this.repo;
    const main = await mainBranch(dir);
    const r = await isAncestor(t.commit, main, dir);
    if (t.status !== 'approved') throw new BusError(`#${t.id} changed while verifying (${t.status})`, 409);
    if (r.err) throw new BusError(`can't verify ${short(t.commit)} in ${main}: ${r.err} — merge it, or use --force`, 409);
    if (!r.in) throw new BusError(`${short(t.commit)} is not in ${main} yet — merge it first with plain git merge ${short(t.commit)} (no squash or rebase)`, 409);
    return this.#finishMerge(t);
  }

  #finishMerge(t) {
    t.status = 'merged';
    Object.assign(this.#mr(t), { status: 'merged' });
    this.#free(t);
    this.bus.log(`#${t.id} merged`);
    this.bus.emit('task', { type: 'merged', task: t });
    for (const d of this.s.tasks.filter((x) => x.after.includes(t.id))) this.offer(d, `#${t.id} merged — rebase and start: `);
    if (t.owner) this.offerNext(t.owner);
    this.#touch(t);
    return t;
  }

  reassign(who, id, to) {
    const t = this.get(id);
    this.#needBoss(who, t, 'reassign');
    to = cleanName(to);
    if (!this.s.agents[to]) throw new BusError(`unknown agent "${to}"`, 404);
    if (!this.bus.isTop(who) && this.s.agents[to].team !== t.team) throw new BusError(`${to} is not on team ${t.team}`, 403);
    if (['merged', 'dropped'].includes(t.status)) throw new BusError(`#${t.id} is ${t.status}`, 409);
    const old = t.owner;
    this.#free(t);
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    Object.assign(t, { owner: null, status: 'open', assignee: to, offered: [], branch: null, commit: null });
    this.bus.log(`#${t.id} reassigned ${old ?? '-'} -> ${to}`);
    this.bus.emit('task', { type: 'reassigned', task: t });
    if (old && old !== to) { this.bus.notify(old, `#${t.id} was reassigned to ${to} — stop work on it`); this.offerNext(old); }
    this.offer(t);
    this.#touch(t);
    return t;
  }

  drop(who, id) {
    const t = this.get(id);
    this.#needBoss(who, t, 'drop');
    if (t.status === 'merged') throw new BusError(`#${t.id} is already merged`, 409);
    const old = t.owner;
    this.#free(t);
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    t.status = 'dropped';
    t.owner = null;
    this.bus.log(`#${t.id} dropped`);
    this.bus.emit('task', { type: 'dropped', task: t });
    if (old) { this.bus.notify(old, `#${t.id} was dropped — stop work on it`); this.offerNext(old); }
    const blocked = this.s.tasks.filter((x) => x.after.includes(t.id) && !['merged', 'dropped'].includes(x.status));
    const rev = this.reviewer(t);
    if (blocked.length && who !== rev) {
      this.bus.notify(rev, `#${t.id} dropped — ${blocked.map((x) => '#' + x.id).join(',')} depend on it and can never start; drop or re-plan them`);
    } else if (blocked.length) this.bus.log(`#${t.id} dropped; ${blocked.map((x) => '#' + x.id).join(',')} now blocked`);
    this.#touch(t);
    return t;
  }

  /** Release the owner's claims and clear its current task (one task at a time, so all its claims). */
  #free(t) {
    const a = t.owner && this.s.agents[t.owner];
    if (!a) return;
    this.bus.release(a.name, null, true);
    if (a.task === t.id) { a.task = null; a.lastTask = t.id; } // usage reported after this still counts toward t
  }

  /** "approve #4" / "@fe-lead reject #4 reason" from the human in chat (any one @mention prefix). */
  #chatApproval(m) {
    // Whole-message commands only, so "don't approve #3" or "I'll approve #3 later" never approve anything.
    const ap = /^\s*(?:@[a-z0-9][\w-]*[\s,:]+)?approve\s+#(\d+)\s*[.!]?\s*$/i.exec(m.text);
    const rj = /^\s*(?:@[a-z0-9][\w-]*[\s,:]+)?reject\s+#(\d+)\s*[:-]?\s*(.*)$/is.exec(m.text);
    try {
      if (ap) this.approve(HUMAN, ap[1]);
      else if (rj) this.reject(HUMAN, rj[1], rj[2], { seen: [m.to, ...m.mentions].filter(Boolean) });
    } catch (e) { this.bus.notify(HUMAN, `couldn't apply "${(ap || rj)[0]}": ${e.message}`); }
  }
}
