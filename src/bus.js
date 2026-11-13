// Core bus logic, independent of HTTP: agents/teams, mention-only inboxes, claims, activity log.
import { EventEmitter } from 'node:events';
import { normPath, overlaps, covers } from './paths.js';

export const HUMAN = 'you';
export const LEAD = 'lead'; // legacy single-lead name: acts as the head
export const HEAD = 'head';
export const ROLES = ['worker', 'lead', 'head'];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9][\w-]*)/g;
export const INBOX_CAP = 30;
const ACTIVITY_CAP = 1000;
/**
 * Messages kept in memory/state.json; older ones move to archive.jsonl in batches of ARCHIVE_SLACK. Safe because an
 * inbox never shows more than the newest INBOX_CAP anyway, so a message 1000 back is one no agent would be shown.
 */
export const MESSAGE_KEEP = 1000;
/** A hook notice carries up to this many single-line messages of up to NOTICE_CHARS each, instead of "run bus read". */
export const NOTICE_INLINE = 2;
export const NOTICE_CHARS = 200;
/** Notes stay short so reading one is far cheaper than reading the code; take shows at most NOTES_ON_TAKE. */
export const NOTE_MAX = 600;
export const NOTE_LINES = 5;
export const NOTES_ON_TAKE = 5;
const ARCHIVE_SLACK = 200;

export const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
export const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addUsage = (into, d) => { for (const k of USAGE_KEYS) into[k] = (into[k] || 0) + (d[k] || 0); };

/** "tokens: 1.2M in (96% cached), 41k out" — everything the model read (fresh + cache) vs what it wrote. */
export function fmtUsage(u) {
  if (!u) return '';
  const read = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  const n = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(x));
  const pct = read ? Math.round(((u.cacheRead || 0) / read) * 100) : 0;
  return `tokens: ${n(read)} in (${pct}% cached), ${n(u.output || 0)} out`;
}

export class BusError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const cleanName = (n) => String(n ?? '').trim().replace(/^[@#]/, '').toLowerCase();

export class Bus extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.s = store.state;
  }

  // ---- agents / teams / roles -----------------------------------------

  /** Role of a name: 'head' | 'lead' (of its team) | 'worker' | 'human'. The legacy agent "lead" is the head. */
  roleOf(name) {
    name = cleanName(name);
    if (name === HUMAN) return 'human';
    const a = this.s.agents[name];
    if (a?.role) return a.role;
    return name === LEAD ? HEAD : 'worker';
  }

  /** The head agent's name (or the legacy "lead"), whether or not it has joined. */
  headName() {
    return Object.values(this.s.agents).find((a) => a.role === HEAD)?.name ?? LEAD;
  }

  /** The lead of `team`, or the head when the team has no lead. */
  leadFor(team) {
    return (team && Object.values(this.s.agents).find((a) => a.role === 'lead' && a.team === team)?.name) || this.headName();
  }

  /** Human or head: shared files, interfaces, requests, any team's tasks. */
  isTop(who) { const r = this.roleOf(who); return r === 'human' || r === HEAD; }

  /** May `who` manage work in `team`? Human, head, or that team's lead. */
  isBossOf(who, team) {
    if (this.isTop(who)) return true;
    return this.roleOf(who) === 'lead' && !!team && this.s.agents[cleanName(who)]?.team === team;
  }

  /** Any lead-like role (human, head, team lead). */
  isBoss(who) { return this.roleOf(who) !== 'worker'; }

  #role(name, role, team) {
    role = cleanName(role) || (name === LEAD ? HEAD : 'worker');
    if (!ROLES.includes(role)) throw new BusError(`bad role "${role}" (BUS_ROLE: worker, lead or head)`);
    for (const o of Object.values(this.s.agents)) {
      if (o.name === name) continue;
      if (role === HEAD && this.roleOf(o.name) === HEAD) throw new BusError(`${o.name} is already the head`, 409);
      if (role === 'lead' && o.role === 'lead' && o.team === team) throw new BusError(`${o.name} already leads team ${team}`, 409);
    }
    if (role === 'lead' && !team) throw new BusError('a lead needs a team — set BUS_TEAM');
    return role;
  }

  /** Register or refresh an agent. Any call from an agent counts as activity. */
  touch(name, team, worktree, role = '') {
    name = cleanName(name);
    if (!name || name === HUMAN) return null;
    if (!NAME_RE.test(name) || name === 'bus') throw new BusError(`bad agent name "${name}" (use a-z 0-9 _ -; "bus" is reserved)`);
    team = cleanName(team) || (name === LEAD || cleanName(role) === HEAD ? name : '');
    if (team && !NAME_RE.test(team)) throw new BusError(`bad team name "${team}"`);
    const now = Date.now();
    let a = this.s.agents[name];
    if (!a) {
      if (!team) throw new BusError(`unknown agent "${name}" — set BUS_TEAM and run: bus join`);
      // cursor 0 + joinedSeq: DMs sent before joining (e.g. task offers) are delivered; older mentions are not.
      const r = this.#role(name, role, team);
      a = this.s.agents[name] = { name, team, role: r, worktree: worktree || null, joinedAt: now, lastSeen: now, cursor: 0, joinedSeq: this.s.seq, task: null };
      this.#setTeam(name, null, team);
      this.log(`${name} joined team ${team}${r === 'worker' ? '' : ' as ' + r}`);
      this.store.save();
      this.emit('join', a);
    } else {
      if (role && cleanName(role) !== this.roleOf(name)) throw new BusError(`${name} is registered as ${this.roleOf(name)}, not ${cleanName(role)} — roles are fixed at join`, 409);
      if (team && team !== a.team && a.role === 'lead') throw new BusError(`${name} leads team ${a.team} — a lead can't change team`, 409);
      if (team && team !== a.team) { this.#setTeam(name, a.team, team); this.log(`${name} moved ${a.team} -> ${team}`); a.team = team; }
      if (worktree) a.worktree = worktree;
      a.lastSeen = now;
      if (a.inactive) { a.inactive = false; this.log(`${name} is active again`); }
    }
    this.store.save();
    return a;
  }

  #setTeam(name, from, to) {
    if (from && this.s.teams[from]) {
      const m = this.s.teams[from].members;
      this.s.teams[from].members = m.filter((x) => x !== name);
    }
    (this.s.teams[to] ??= { members: [] }).members.includes(name) || this.s.teams[to].members.push(name);
  }

  who() {
    return Object.values(this.s.agents).map(({ name, team, task, lastSeen, worktree }) => ({ name, team, role: this.roleOf(name), task, lastSeen, worktree }));
  }

  // ---- messages -------------------------------------------------------

  #known(n) { return n === HUMAN || n === LEAD || n in this.s.agents || n in this.s.teams; }

  /**
   * Post a message. `to`: "#channel" | "@agent" | "@team" | empty (sender's team channel).
   * "@agent" is a DM; "@team" posts to that team's channel and mentions the team.
   */
  send(from, to, text) {
    from = cleanName(from) || HUMAN;
    text = String(text ?? '').trim();
    if (!text) throw new BusError('empty message');
    const sender = this.s.agents[from];
    let channel = null, dm = null;
    const mentions = new Set();
    to = String(to ?? '').trim().toLowerCase();
    if (!to) channel = '#' + (sender?.team || 'general');
    else if (to.startsWith('#')) {
      const c = cleanName(to);
      if (!NAME_RE.test(c)) throw new BusError(`bad channel "${to}"`);
      channel = '#' + c;
    } else {
      const t = cleanName(to);
      if (!this.#known(t)) throw new BusError(`unknown agent or team "@${t}" — see: bus who`, 404);
      if (t in this.s.teams && !(t in this.s.agents)) { channel = '#' + t; mentions.add(t); }
      else dm = t;
    }
    for (const [, n] of text.matchAll(MENTION_RE)) {
      const m = n.toLowerCase();
      if (this.#known(m)) mentions.add(m);
    }
    const msg = { id: ++this.s.seq, ts: Date.now(), from, channel, to: dm, text, mentions: [...mentions] };
    this.#push(msg);
    if (sender?.ifacePending) { // announcing an interface change = mentioning (or posting to) its consuming teams
      const reached = new Set([...mentions, ...(channel ? [channel.slice(1)] : [])]);
      for (const [p, teams] of Object.entries(sender.ifacePending)) {
        const left = teams.filter((t) => !reached.has(t));
        if (left.length) sender.ifacePending[p] = left;
        else { delete sender.ifacePending[p]; sender.ifaceNoticed = (sender.ifaceNoticed ?? []).filter((x) => x !== p); }
      }
    }
    this.store.save();
    this.emit('message', msg);
    return msg;
  }

  /** System DM from "bus" (task offers, merges, rejections). Recipient need not have joined yet. */
  notify(to, text) {
    const msg = { id: ++this.s.seq, ts: Date.now(), from: 'bus', channel: null, to: cleanName(to), text, mentions: [] };
    this.#push(msg);
    this.store.save();
    this.emit('message', msg);
    return msg;
  }

  /** Append a message; past MESSAGE_KEEP + ARCHIVE_SLACK, move the oldest to the archive file. */
  #push(msg) {
    const ms = this.s.messages;
    ms.push(msg);
    if (ms.length <= MESSAGE_KEEP + ARCHIVE_SLACK) return;
    const old = ms.splice(0, ms.length - MESSAGE_KEEP);
    this.s.archivedThrough = old.at(-1).id;
    this.store.archive?.(old);
  }

  /** Is `msg` addressed to `agent` (DM, @name, @team)? Never the sender's own messages. */
  isFor(msg, agent) {
    if (msg.from === agent.name) return false;
    if (msg.to) return msg.to === agent.name;
    return msg.mentions.includes(agent.name) || (!!agent.team && msg.mentions.includes(agent.team));
  }

  #unread(agent) {
    const out = [];
    const ms = this.s.messages;
    const joined = agent.joinedSeq ?? 0;
    for (let i = ms.length - 1; i >= 0 && ms[i].id > agent.cursor; i--) {
      const m = ms[i];
      if ((m.to || m.id > joined) && this.isFor(m, agent)) out.push(m);
    }
    return out.reverse();
  }

  #agent(name) {
    const a = this.s.agents[cleanName(name)];
    if (!a) throw new BusError(`unknown agent "${name}" — run: bus join`, 404);
    return a;
  }

  pending(name) { return this.#unread(this.#agent(name)).length; }

  /**
   * One-line hook notice, or null. Fires once per new batch: if the agent ignores it, later tool
   * calls stay silent until something newer arrives (so ignored notices don't keep costing tokens).
   */
  notice(name) {
    const a = this.#agent(name);
    const lines = [];
    const un = this.#unread(a);
    const newest = un.at(-1)?.id ?? 0;
    if (un.length && newest > (a.noticed ?? 0)) {
      a.noticed = newest;
      if (un.length <= NOTICE_INLINE && un.every((m) => m.text.length <= NOTICE_CHARS && !m.text.includes('\n'))) {
        // Short enough to deliver here: saves the agent a `bus read` tool call. Counts as read.
        for (const m of un) lines.push(`bus: ${m.id} ${m.from}>${m.channel ?? '@' + m.to}: ${m.text}`);
        a.cursor = newest;
      } else {
        const from = [...new Set(un.map((m) => '@' + m.from))].slice(0, 3).join(', ');
        lines.push(`bus: ${un.length} new for you (from ${from}) — run: bus read`);
      }
    }
    for (const [p, teams] of Object.entries(a.ifacePending ?? {})) {
      if ((a.ifaceNoticed ??= []).includes(p)) continue;
      a.ifaceNoticed.push(p);
      lines.push(`bus: you changed interface ${p} — announce it: bus send ${teams.map((t) => '@' + t).join(' ')} "<what changed>"`);
    }
    if (!lines.length) return null;
    this.store.save();
    return lines.join('\n');
  }

  /** Unread inbox, capped to the newest INBOX_CAP; advances the read cursor. */
  read(name) {
    const a = this.#agent(name);
    const all = this.#unread(a);
    const skipped = Math.max(0, all.length - INBOX_CAP);
    a.cursor = this.s.seq;
    this.store.save();
    return { messages: all.slice(skipped), skipped };
  }

  show(id) {
    const m = this.s.messages.find((x) => x.id === Number(id));
    if (!m && Number(id) <= (this.s.archivedThrough ?? 0)) throw new BusError(`message ${id} is archived (.bus/archive.jsonl)`, 404);
    if (!m) throw new BusError(`no message ${id}`, 404);
    return m;
  }

  /** Explicitly read a channel (or the DMs involving `name` when channel is omitted). */
  channelLog(name, channel, n = 20) {
    n = Math.min(Math.max(1, Number(n) || 20), 200);
    const me = cleanName(name);
    const c = channel ? '#' + cleanName(channel) : null;
    const hits = this.s.messages.filter((m) => (c ? m.channel === c : m.to && (m.to === me || m.from === me)));
    return { messages: hits.slice(-n), skipped: Math.max(0, hits.length - n) };
  }

  // ---- claims ---------------------------------------------------------

  claim(name, paths, why = '') {
    const a = this.#agent(name);
    const want = [...new Set(paths.map(normPath).filter(Boolean))];
    if (!want.length) throw new BusError('no paths given');
    const conflicts = [];
    for (const p of want) {
      for (const c of this.s.claims) {
        if (c.agent !== a.name && overlaps(p, c.path)) conflicts.push({ path: p, owner: c.agent, claim: c.path });
      }
      if (this.roleOf(a.name) !== HEAD) {
        for (const h of this.s.hotFiles) if (overlaps(p, h)) conflicts.push({ path: p, owner: this.headName(), claim: h, hot: true });
      }
    }
    if (conflicts.length) return { ok: false, conflicts };
    const mine = new Set(this.s.claims.filter((c) => c.agent === a.name).map((c) => c.path));
    const added = want.filter((p) => !mine.has(p));
    for (const p of added) this.s.claims.push({ path: p, agent: a.name, why: String(why || ''), ts: Date.now() });
    if (added.length) this.log(`${a.name} claimed ${added.join(', ')}`);
    this.store.save();
    return { ok: true, claimed: want };
  }

  release(name, paths, all = false) {
    const a = this.#agent(name);
    const drop = new Set((paths || []).map(normPath));
    const before = this.s.claims.length;
    const gone = [];
    this.s.claims = this.s.claims.filter((c) => {
      const hit = c.agent === a.name && (all || drop.has(c.path));
      if (hit) gone.push(c.path);
      return !hit;
    });
    if (gone.length) { this.log(`${a.name} released ${gone.join(', ')}`); this.store.save(); }
    return { released: before - this.s.claims.length, paths: gone };
  }

  claims(name) {
    const me = name ? cleanName(name) : null;
    return this.s.claims.filter((c) => !me || c.agent === me);
  }

  /**
   * Is repo-relative `file` free for `name` to edit? Hot files belong to the lead.
   * With `editing` (the edit-guard hook), an allowed edit to an interface file is recorded so the
   * agent is reminded to announce it, and can't finish its task until it has.
   */
  check(name, file, { editing = false } = {}) {
    const me = cleanName(name);
    const f = normPath(file);
    const other = this.s.claims.find((c) => c.agent !== me && covers(c.path, f));
    if (other) return { free: false, owner: other.agent, claim: other.path };
    if (this.roleOf(me) !== HEAD) {
      const hot = this.s.hotFiles.find((h) => covers(h, f));
      if (hot) return { free: false, owner: this.headName(), claim: hot, hot: true };
    }
    const iface = this.s.interfaces.find((i) => covers(i.path, f));
    const a = this.s.agents[me];
    if (editing && iface && a && iface.teams.some((t) => t !== a.team)) {
      (a.ifacePending ??= {})[iface.path] = iface.teams.filter((t) => t !== a.team);
      this.store.save();
    }
    return { free: true, mine: this.s.claims.some((c) => c.agent === me && covers(c.path, f)), ...(iface && { iface: iface.path }) };
  }

  /** Releasing another agent's claims: the human always; the head, or the agent's team lead, only for inactive agents. */
  releaseOf(who, target, paths, all = false) {
    const t = this.#agent(target);
    if (who !== HUMAN && !(t.inactive && this.isBossOf(who, t.team) && who !== t.name)) throw new BusError("only the human, or the head or the agent's team lead for an inactive agent, can release its claims", 403);
    return this.release(t.name, paths, all);
  }

  // ---- hot files, change requests, interfaces (DESIGN.md §5) ---------

  #boss(who, what) { if (!this.isTop(who)) throw new BusError(`only the head or the human can ${what}`, 403); }

  hotAdd(who, paths) {
    this.#boss(who, 'manage hot files');
    const add = [...new Set(paths.map(normPath))].filter((p) => p && !this.s.hotFiles.includes(p));
    this.s.hotFiles.push(...add);
    if (add.length) this.log(`hot files added: ${add.join(', ')}`);
    this.store.save();
    return this.s.hotFiles;
  }

  hotRm(who, paths) {
    this.#boss(who, 'manage hot files');
    const drop = new Set(paths.map(normPath));
    this.s.hotFiles = this.s.hotFiles.filter((h) => !drop.has(h));
    this.store.save();
    return this.s.hotFiles;
  }

  /** An agent asks the head to change a hot file. */
  request(who, file, text) {
    const a = this.#agent(who);
    file = normPath(file);
    text = String(text ?? '').trim();
    if (!file || !text) throw new BusError('usage: bus request <file> "change"');
    this.s.requests ??= [];
    const r = { id: (this.s.requests.at(-1)?.id ?? 0) + 1, file, agent: a.name, text, status: 'open', reason: '', ts: Date.now() };
    this.s.requests.push(r);
    this.log(`${a.name} requested change to ${file}`);
    this.notify(this.headName(), `request r${r.id} from ${a.name} — ${file}: ${text} — bus request done|decline ${r.id} ["why"]`);
    return r;
  }

  resolveRequest(who, id, verdict, why = '') {
    this.#boss(who, 'resolve requests');
    const r = (this.s.requests ?? []).find((x) => x.id === Number(String(id).replace(/^r/i, '')));
    if (!r) throw new BusError(`no request ${id}`, 404);
    if (r.status !== 'open') throw new BusError(`request r${r.id} is already ${r.status}`, 409);
    if (!['done', 'decline'].includes(verdict)) throw new BusError('verdict must be done or decline');
    r.status = verdict === 'done' ? 'done' : 'declined';
    r.reason = String(why || '').trim();
    this.log(`request r${r.id} ${r.status}`);
    this.notify(r.agent, `request r${r.id} (${r.file}) ${r.status}${r.reason ? ': ' + r.reason : ''}${r.status === 'done' ? ' — rebase/pull to get it' : ''}`);
    return r;
  }

  ifaceAdd(who, path, teams) {
    this.#boss(who, 'mark interfaces');
    path = normPath(path);
    teams = [...new Set(teams.map(cleanName).filter(Boolean))];
    if (!path || !teams.length) throw new BusError('usage: bus iface add <path> --teams a,b');
    this.s.interfaces = this.s.interfaces.filter((i) => i.path !== path);
    this.s.interfaces.push({ path, teams });
    this.log(`interface ${path} -> ${teams.join(', ')}`);
    this.store.save();
    return this.s.interfaces;
  }

  ifaceRm(who, path) {
    this.#boss(who, 'mark interfaces');
    path = normPath(path);
    this.s.interfaces = this.s.interfaces.filter((i) => i.path !== path);
    this.store.save();
    return this.s.interfaces;
  }

  /** Interface edits not yet announced to all consuming teams. */
  unannounced(name) { return Object.entries(this.s.agents[cleanName(name)]?.ifacePending ?? {}); }

  // ---- notes: short shared knowledge about a file or dir/, so the next agent reads a summary, not the source ----

  noteAdd(who, p, text) {
    const a = this.#agent(who);
    p = normPath(p);
    text = String(text ?? '').trim();
    if (!p || !text) throw new BusError('usage: bus note add <path> "text"');
    if (text.length > NOTE_MAX) throw new BusError(`a note is at most ${NOTE_MAX} chars (got ${text.length})`);
    if (text.split('\n').length > NOTE_LINES) throw new BusError(`a note is at most ${NOTE_LINES} lines`);
    (this.s.notes ??= {})[p] = { path: p, text, by: a.name, ts: Date.now() };
    this.log(`${a.name} noted ${p}`);
    this.store.save();
    return this.s.notes[p];
  }

  note(p) {
    const n = this.s.notes?.[normPath(p)];
    if (!n) throw new BusError(`no note on ${normPath(p)}`, 404);
    return n;
  }

  /** Its author, a lead or the head (or the human) may remove a note. */
  noteRm(who, p) {
    const n = this.note(p);
    if (cleanName(who) !== n.by && !this.isBoss(who)) throw new BusError(`only ${n.by} or a lead can remove the note on ${n.path}`, 403);
    delete this.s.notes[n.path];
    this.store.save();
    return n;
  }

  notes() { return Object.values(this.s.notes ?? {}); }

  /** Notes on anything overlapping `paths` (a file, its dir, a glob), newest first, capped for `bus task take`. */
  notesFor(paths, cap = NOTES_ON_TAKE) {
    const want = paths.map(normPath).filter(Boolean);
    if (!want.length) return [];
    return this.notes().filter((n) => want.some((p) => overlaps(p, n.path))).sort((x, y) => y.ts - x.ts).slice(0, cap);
  }

  // ---- token usage (measured by the Stop hook from the session transcript) ----

  /**
   * `totals` are a session's cumulative counts. The increase since that session's last report is added to the agent
   * and to its current task (or the task it last held, for the turns after it was merged). Never sent to inboxes.
   */
  recordUsage(name, session, totals = {}) {
    const a = this.#agent(name);
    const cur = Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.max(0, Number(totals[k]) || 0)]));
    session = String(session || 'default').slice(0, 200);
    a.sessions ??= {};
    const prev = a.sessions[session] ?? {};
    const delta = Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.max(0, cur[k] - (prev[k] || 0))]));
    delete a.sessions[session];
    a.sessions[session] = cur; // re-insert: most recent last
    const keys = Object.keys(a.sessions);
    if (keys.length > 10) delete a.sessions[keys[0]];
    addUsage((a.usage ??= zeroUsage()), delta);
    const t = this.s.tasks.find((x) => x.id === (a.task ?? a.lastTask));
    if (t) addUsage((t.usage ??= zeroUsage()), delta);
    this.store.save();
    return { agent: a.usage, task: t?.usage ?? null };
  }

  // ---- inactivity ------------------------------------------------------

  /** Flag agents silent longer than `ms` (skipping `busy` names, e.g. blocked in bus wait); tell its lead once. */
  sweep(ms, busy = new Set(), now = Date.now()) {
    const flagged = [];
    for (const a of Object.values(this.s.agents)) {
      if (a.inactive || this.roleOf(a.name) === HEAD || busy.has(a.name) || (a.spawned && this.s.spawns?.[a.name]?.status !== 'running') || now - a.lastSeen < ms) continue;
      a.inactive = true;
      flagged.push(a.name);
      const mins = Math.round((now - a.lastSeen) / 60000);
      this.log(`${a.name} inactive (${mins}m)`);
      const fix = a.task ? `bus task reassign ${a.task} <agent>` : `bus release --of ${a.name} --all`;
      const boss = a.role === 'lead' ? this.headName() : this.leadFor(a.team);
      this.notify(boss, `${a.name} inactive ${mins}m${a.task ? ' (task #' + a.task + ')' : ''} — ${fix}`);
    }
    if (flagged.length) this.store.save();
    return flagged;
  }

  // ---- activity log (dashboard only) ----------------------------------

  log(text) {
    const e = { ts: Date.now(), text };
    this.s.activity.push(e);
    if (this.s.activity.length > ACTIVITY_CAP) this.s.activity.splice(0, this.s.activity.length - ACTIVITY_CAP);
    this.store.save();
    this.emit('activity', e);
  }
}
