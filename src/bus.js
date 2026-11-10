// Core bus logic, independent of HTTP: agents/teams, mention-only inboxes, claims, activity log.
import { EventEmitter } from 'node:events';
import { normPath, overlaps, covers } from './paths.js';

export const HUMAN = 'you';
export const LEAD = 'lead';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9][\w-]*)/g;
export const INBOX_CAP = 30;
const ACTIVITY_CAP = 1000;

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

  // ---- agents / teams -------------------------------------------------

  /** Register or refresh an agent. Any call from an agent counts as activity. */
  touch(name, team, worktree) {
    name = cleanName(name);
    if (!name || name === HUMAN) return null;
    if (!NAME_RE.test(name)) throw new BusError(`bad agent name "${name}" (use a-z 0-9 _ -)`);
    team = cleanName(team) || (name === LEAD ? LEAD : '');
    if (team && !NAME_RE.test(team)) throw new BusError(`bad team name "${team}"`);
    const now = Date.now();
    let a = this.s.agents[name];
    if (!a) {
      if (!team) throw new BusError(`unknown agent "${name}" — set BUS_TEAM and run: bus join`);
      a = this.s.agents[name] = { name, team, worktree: worktree || null, joinedAt: now, lastSeen: now, cursor: this.s.seq, task: null };
      this.#setTeam(name, null, team);
      this.log(`${name} joined team ${team}`);
    } else {
      if (team && team !== a.team) { this.#setTeam(name, a.team, team); this.log(`${name} moved ${a.team} -> ${team}`); a.team = team; }
      if (worktree) a.worktree = worktree;
      a.lastSeen = now;
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
    return Object.values(this.s.agents).map(({ name, team, task, lastSeen, worktree }) => ({ name, team, task, lastSeen, worktree }));
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
    this.s.messages.push(msg);
    this.store.save();
    this.emit('message', msg);
    return msg;
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
    for (let i = ms.length - 1; i >= 0 && ms[i].id > agent.cursor; i--) {
      if (this.isFor(ms[i], agent)) out.push(ms[i]);
    }
    return out.reverse();
  }

  #agent(name) {
    const a = this.s.agents[cleanName(name)];
    if (!a) throw new BusError(`unknown agent "${name}" — run: bus join`, 404);
    return a;
  }

  pending(name) { return this.#unread(this.#agent(name)).length; }

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

  /** Is repo-relative `file` free for `name` to edit? */
  check(name, file) {
    const me = cleanName(name);
    const f = normPath(file);
    const other = this.s.claims.find((c) => c.agent !== me && covers(c.path, f));
    if (other) return { free: false, owner: other.agent, claim: other.path };
    return { free: true, mine: this.s.claims.some((c) => c.agent === me && covers(c.path, f)) };
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
