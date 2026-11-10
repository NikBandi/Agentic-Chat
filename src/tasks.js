// Tasks: dependencies, take (claims files), done-checks, merge requests, approval, merge, auto-handoff.
// Lifecycle: open -> in_progress -> review -> approved -> merged      (+ dropped; reject: review -> in_progress)
import { BusError, HUMAN, LEAD, cleanName } from './bus.js';
import { normPath } from './paths.js';
import { runCheck, currentBranch } from './check.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const isBoss = (who) => who === LEAD || who === HUMAN;
const num = (id) => Number(String(id ?? '').replace(/^#/, ''));

export class Tasks {
  constructor(bus) {
    this.bus = bus;
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
  #mayTake(t, a) { return !t.assignee || t.assignee === a.name || t.assignee === a.team; }

  add(who, { title, brief = '', files = [], check, after = [], assignee, timeout } = {}) {
    if (!isBoss(who)) throw new BusError('only the lead or the human can add tasks', 403);
    title = String(title ?? '').trim();
    if (!title) throw new BusError('task needs a title');
    check = String(check ?? '').trim();
    if (!check) throw new BusError('task needs a done-check: --check "cmd"');
    const deps = [...new Set(after.map(num))];
    for (const d of deps) this.get(d);
    assignee = cleanName(assignee) || null;
    if (assignee && !NAME_RE.test(assignee)) throw new BusError(`bad assignee "${assignee}"`);
    const now = Date.now();
    const t = {
      id: ++this.s.taskSeq, title, brief: String(brief), files: [...new Set(files.map(normPath).filter(Boolean))],
      check, after: deps, assignee, status: 'open', owner: null, offered: [],
      timeout: Math.min(Math.max(1, Number(timeout) || 600), 3600), result: null, summary: '', branch: null,
      createdAt: now, updatedAt: now,
    };
    this.s.tasks.push(t);
    this.bus.log(`task #${t.id} added: ${t.title}${assignee ? ' for ' + assignee : ''}`);
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
        .filter((a) => !a.task && a.name !== LEAD && this.#mayTake(t, a) && !t.offered.includes(a.name))
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
    if (!a || a.task || a.name === LEAD) return;
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
    if (!this.#mayTake(t, a)) throw new BusError(`#${t.id} is assigned to ${t.assignee}`, 403);
    if (a.task && a.task !== t.id) throw new BusError(`finish #${a.task} first (one task at a time)`, 409);
    if (t.files.length) {
      const r = this.bus.claim(who, t.files, `task #${t.id}`);
      if (!r.ok) {
        const c = r.conflicts.map((x) => `${x.path} (held by ${x.owner})`).join(', ');
        throw new BusError(`can't claim ${c} — ask the owner or @lead`, 409);
      }
    }
    Object.assign(t, { owner: who, status: 'in_progress' });
    a.task = t.id;
    this.bus.log(`${who} took #${t.id}`);
    this.#touch(t);
    return t;
  }

  /** Runs the done-check in the owner's worktree. Pass -> merge request for the lead. */
  async done(who, id, summary = '') {
    const t = this.get(id);
    if (t.owner !== who) throw new BusError(`#${t.id} is not yours`, 403);
    if (t.status !== 'in_progress') throw new BusError(`#${t.id} is ${t.status}`, 409);
    if (this.running.has(t.id)) throw new BusError(`#${t.id} check already running`, 409);
    const a = this.s.agents[who];
    if (!a.worktree) throw new BusError('worktree unknown — run bus join from your worktree', 400);
    const owed = this.bus.unannounced(who);
    if (owed.length) {
      const [p, teams] = owed[0];
      throw new BusError(`announce your interface change first: bus send ${teams.map((x) => '@' + x).join(' ')} "<what changed in ${p}>"`, 409);
    }
    this.running.add(t.id);
    let r;
    try { r = await runCheck(t.check, a.worktree, t.timeout); }
    finally { this.running.delete(t.id); }
    t.result = { ok: r.ok, code: r.code, output: r.output, ms: r.ms, ts: Date.now() };
    if (t.status !== 'in_progress' || t.owner !== who) { this.#touch(t); throw new BusError(`#${t.id} changed while the check ran (${t.status})`, 409); }
    if (!r.ok) {
      this.bus.log(`#${t.id} check failed (${who})`);
      this.#touch(t);
      return { ok: false, code: r.code, output: r.output };
    }
    t.branch = await currentBranch(a.worktree);
    t.summary = String(summary || '').trim();
    t.status = 'review';
    const mr = { task: t.id, agent: who, branch: t.branch, summary: t.summary, status: 'pending', reason: '', ts: Date.now() };
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    this.s.mergeRequests.push(mr);
    this.bus.log(`#${t.id} passed its check — merge request from ${who}`);
    this.bus.notify(LEAD, `#${t.id} passed its check (${who}, branch ${t.branch ?? '?'})${t.summary ? ': ' + t.summary : ''} — review, then ask @you to approve`);
    this.#touch(t);
    return { ok: true, mr };
  }

  approve(who, id) {
    if (who !== HUMAN) throw new BusError('only the human approves merges', 403);
    const t = this.get(id);
    if (t.status !== 'review') throw new BusError(`#${t.id} is ${t.status}, not awaiting approval`, 409);
    t.status = 'approved';
    Object.assign(this.#mr(t), { status: 'approved' });
    this.bus.log(`#${t.id} approved`);
    this.bus.notify(LEAD, `#${t.id} approved — merge ${t.branch ?? 'its branch'}, then: bus task merged ${t.id}`);
    this.#touch(t);
    return t;
  }

  reject(who, id, why = '', { leadSaw = false } = {}) {
    if (who !== HUMAN) throw new BusError('only the human rejects merges', 403);
    const t = this.get(id);
    if (!['review', 'approved'].includes(t.status)) throw new BusError(`#${t.id} is ${t.status}, nothing to reject`, 409);
    why = String(why || '').trim() || 'no reason given';
    t.status = 'in_progress';
    Object.assign(this.#mr(t), { status: 'rejected', reason: why });
    this.bus.log(`#${t.id} rejected: ${why}`);
    this.bus.notify(t.owner, `#${t.id} rejected: ${why} — fix it, then: bus task done ${t.id}`);
    if (!leadSaw) this.bus.notify(LEAD, `#${t.id} rejected: ${why}`);
    this.#touch(t);
    return t;
  }

  /** Lead reports the branch is merged: release claims, hand off to dependents, free the owner. */
  merged(who, id) {
    if (!isBoss(who)) throw new BusError('only the lead marks tasks merged', 403);
    const t = this.get(id);
    if (t.status !== 'approved') throw new BusError(`#${t.id} is ${t.status} — it needs human approval first`, 409);
    t.status = 'merged';
    Object.assign(this.#mr(t), { status: 'merged' });
    this.#free(t);
    this.bus.log(`#${t.id} merged`);
    for (const d of this.s.tasks.filter((x) => x.after.includes(t.id))) this.offer(d, `#${t.id} merged — rebase and start: `);
    if (t.owner) this.offerNext(t.owner);
    this.#touch(t);
    return t;
  }

  reassign(who, id, to) {
    if (!isBoss(who)) throw new BusError('only the lead or the human can reassign', 403);
    const t = this.get(id);
    to = cleanName(to);
    if (!this.s.agents[to]) throw new BusError(`unknown agent "${to}"`, 404);
    if (['merged', 'dropped'].includes(t.status)) throw new BusError(`#${t.id} is ${t.status}`, 409);
    const old = t.owner;
    this.#free(t);
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    Object.assign(t, { owner: null, status: 'open', assignee: to, offered: [] });
    this.bus.log(`#${t.id} reassigned ${old ?? '-'} -> ${to}`);
    if (old && old !== to) { this.bus.notify(old, `#${t.id} was reassigned to ${to} — stop work on it`); this.offerNext(old); }
    this.offer(t);
    this.#touch(t);
    return t;
  }

  drop(who, id) {
    if (!isBoss(who)) throw new BusError('only the lead or the human can drop tasks', 403);
    const t = this.get(id);
    if (t.status === 'merged') throw new BusError(`#${t.id} is already merged`, 409);
    const old = t.owner;
    this.#free(t);
    this.s.mergeRequests = this.s.mergeRequests.filter((m) => m.task !== t.id);
    t.status = 'dropped';
    t.owner = null;
    this.bus.log(`#${t.id} dropped`);
    if (old) { this.bus.notify(old, `#${t.id} was dropped — stop work on it`); this.offerNext(old); }
    const blocked = this.s.tasks.filter((x) => x.after.includes(t.id) && !['merged', 'dropped'].includes(x.status));
    if (blocked.length && who !== LEAD) {
      this.bus.notify(LEAD, `#${t.id} dropped — ${blocked.map((x) => '#' + x.id).join(',')} depend on it and can never start; drop or re-plan them`);
    } else if (blocked.length) this.bus.log(`#${t.id} dropped; ${blocked.map((x) => '#' + x.id).join(',')} now blocked`);
    this.#touch(t);
    return t;
  }

  /** Release the owner's claims and clear its current task (one task at a time, so all its claims). */
  #free(t) {
    const a = t.owner && this.s.agents[t.owner];
    if (!a) return;
    this.bus.release(a.name, null, true);
    if (a.task === t.id) a.task = null;
  }

  /** "@lead approve #4" / "@lead reject #4 reason" from the human in chat. */
  #chatApproval(m) {
    // Whole-message commands only, so "don't approve #3" or "I'll approve #3 later" never approve anything.
    const ap = /^\s*(?:@lead[\s,:]+)?approve\s+#(\d+)\s*[.!]?\s*$/i.exec(m.text);
    const rj = /^\s*(?:@lead[\s,:]+)?reject\s+#(\d+)\s*[:-]?\s*(.*)$/is.exec(m.text);
    try {
      if (ap) this.approve(HUMAN, ap[1]);
      else if (rj) this.reject(HUMAN, rj[1], rj[2], { leadSaw: m.to === LEAD || m.mentions.includes(LEAD) });
    } catch (e) { this.bus.notify(HUMAN, `couldn't apply "${(ap || rj)[0]}": ${e.message}`); }
  }
}
