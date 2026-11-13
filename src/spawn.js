// Lead-spawned workers: `bus spawn <task>` makes a git worktree and starts a headless Claude Code worker that sees
// only that task. At most BUS_MAX_WORKERS (default 4) run at once across the whole bus; extra spawns queue and start
// as slots free up. A worker exits once its task passes its check (no idle sessions); a rejected task re-spawns it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as cpSpawn, execFile } from 'node:child_process';
import { BusError, cleanName } from './bus.js';
import { mergeSettings } from './init.js';
import { addWorktree, removeWorktree, worktreeRoot } from './worktree.js';

export const DEFAULT_MAX = 4;
/** `bus worktree prune` leaves anything touched this recently alone (an agent may be about to start in it). */
export const PRUNE_GRACE_MS = 10 * 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const maxWorkers = (env = process.env) => Math.min(Math.max(1, Number(env.BUS_MAX_WORKERS) || DEFAULT_MAX), 16);

/**
 * The worker's whole instruction set: short, because every worker pays for it. Spawned workers get no SessionStart
 * rules (BUS_SPAWNED), so the few rules that matter to them are here.
 */
export function workerPrompt({ name, team, task, reason = '' }) {
  return [
    `You are ${name}, a worker on team ${team}, in your own git worktree. Your only job is task #${task}.`,
    reason && `It was sent back: ${reason}. Fix that.`,
    `1. bus join   2. bus task take ${task} (prints the brief, files to read first and notes: your full context)`,
    `3. Do the work (tests first), commit on your branch.`,
    `4. bus task done ${task} --report "<what you built; problems; anything unfinished — max 3 lines>". If the check fails, fix and rerun.`,
    `When bus task done says the check passed, stop: you are finished. Blocked on someone? bus send @<agent> "..." then bus wait.`,
    `Edit only files your task claims; if an edit is blocked, ask the owner — never work around it. Hot files: bus request <file> "change".`,
    `Hook notices show short messages inline, else run bus read. Learned a module others need? bus note add <path> "<≤5 lines>".`,
  ].filter(Boolean).join('\n');
}

/** Prompt for a rejected worker resumed in its own session: it already knows the task and the code. */
export const resumePrompt = ({ task, reason }) =>
  `#${task} was sent back: ${reason}. Fix that, commit, then bus task done ${task} --report "<max 3 lines>". When the check passes, stop.`;

/** Shell commands every worker may run without a prompt: the bus itself and git. The task's check is added per task. */
export const WORKER_ALLOW = ['Bash(bus:*)', 'Bash(git:*)'];

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export const DEFAULT_WORKER_MODEL = 'sonnet';
export const DEFAULT_SETTING_SOURCES = 'project,local';

/**
 * argv for the worker process.
 * - Lean: no MCP servers (--strict-mcp-config) and no user-level settings (--setting-sources project,local), so a
 *   worker doesn't load the human's plugins, hooks and MCP tools. BUS_WORKER_SETTING_SOURCES=all loads everything.
 * - Model: BUS_WORKER_MODEL, default sonnet; "default" passes no --model (the CLI's own default).
 * - JSON output: the final result carries session_id (for --resume on reject) and cost.
 * - Permissions: acceptEdits by default: file edits in the worktree are allowed, and shell commands only from an
 *   allowlist (bus, git, the task's done-check, plus BUS_WORKER_ALLOW). Headless sessions can't answer prompts, so
 *   anything else is denied. BUS_WORKER_PERMISSION=bypassPermissions restores the old behaviour.
 */
export function workerArgs(prompt, settingsFile, env = process.env, { check = '', resume = '' } = {}) {
  const mode = env.BUS_WORKER_PERMISSION || 'acceptEdits';
  const sources = env.BUS_WORKER_SETTING_SOURCES || DEFAULT_SETTING_SOURCES;
  const model = env.BUS_WORKER_MODEL || DEFAULT_WORKER_MODEL;
  const args = ['-p', prompt, '--output-format', 'json', '--settings', settingsFile, '--strict-mcp-config'];
  if (sources !== 'all') args.push('--setting-sources', sources);
  args.push('--permission-mode', mode);
  if (model !== 'default') args.push('--model', model);
  if (env.BUS_WORKER_BUDGET) args.push('--max-budget-usd', String(env.BUS_WORKER_BUDGET));
  if (resume) args.push('--resume', resume);
  if (mode !== 'bypassPermissions') {
    args.push('--allowedTools', ...WORKER_ALLOW, ...(check ? [`Bash(${check})`] : []), ...csv(env.BUS_WORKER_ALLOW));
  }
  return args;
}

export const TAIL_CHARS = 300;

/**
 * What a worker run left in its log (from byte `start`): the --output-format json result object, if any, and a short
 * one-line tail for the lead: the result text, else the last few log lines.
 */
export function readRun(log, start = 0) {
  let text = '';
  try {
    const buf = fs.readFileSync(log);
    text = buf.subarray(Math.min(start, buf.length)).toString('utf8');
  } catch { return { result: null, tail: '' }; }
  let result = null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0 && !result; i--) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try { const o = JSON.parse(lines[i]); if (o?.type === 'result') result = o; } catch { /* not JSON */ }
  }
  const raw = typeof result?.result === 'string' && result.result.trim() ? result.result : lines.filter((l) => !l.trimStart().startsWith('{')).slice(-5).join(' ⏎ ');
  const flat = raw.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return { result, tail: flat.length > TAIL_CHARS ? '…' + flat.slice(-TAIL_CHARS) : flat };
}

/** Default launcher: start the process with output to a log file; returns {pid, kill, onExit}. */
function launch({ cmd, args, cwd, env, log }) {
  const fd = fs.openSync(log, 'a');
  const p = cpSpawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  return {
    pid: p.pid,
    kill: () => {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {});
      else p.kill('SIGTERM');
    },
    onExit: (fn) => { p.on('error', (e) => fn(-1, e.message)); p.on('exit', (code) => fn(code)); },
  };
}

export class Spawner {
  /**
   * repo: the main checkout (worktrees go in <repo>.worktrees/<agent>, or BUS_WORKTREE_DIR). dataDir: logs and worker settings.
   * launcher: injectable for tests. Lifecycle per worker: queued -> running -> exited (re-queued on reject).
   */
  constructor(bus, tasks, { repo = process.cwd(), dataDir = null, launcher = launch, env = process.env, port = null } = {}) {
    Object.assign(this, { bus, tasks, repo, launcher, env, port });
    this.dataDir = dataDir || path.join(repo, '.bus');
    this.s = bus.s;
    this.s.spawns ??= {};
    this.s.worktrees ??= {}; // made by `bus worktree` for agents started by hand
    this.procs = new Map(); // name -> handle (this server process only)
    this.pumping = false;
    this.again = false;
    // Workers that were running when the server stopped are gone; don't count them.
    for (const w of Object.values(this.s.spawns)) if (['running', 'starting'].includes(w.status)) Object.assign(w, { status: 'exited', note: 'server restarted' });
    bus.on('task', (ev) => this.#onTask(ev));
  }

  get max() { return maxWorkers(this.env); }
  running() { return Object.values(this.s.spawns).filter((w) => w.status === 'running'); }
  list() { return Object.values(this.s.spawns); }

  /** A lead (own team), the head or the human asks for a worker on task `id`. Returns the worker record. */
  request(who, id) {
    const t = this.tasks.get(id);
    if (!this.bus.isBossOf(who, t.team)) throw new BusError(`only ${this.tasks.reviewer(t)}, the head or the human can spawn for #${t.id}`, 403);
    if (!t.team) throw new BusError(`#${t.id} has no team — add it with --team (or --for a team) first`, 400);
    const live = this.list().find((w) => w.task === t.id && ['queued', 'starting', 'running'].includes(w.status));
    if (live) return live;
    let name;
    if (t.status === 'open') {
      name = this.#newName(t.team);
      t.assignee = name; // reserved for this worker
      t.offered = [...new Set([...(t.offered ?? []), name])];
    } else if (t.status === 'in_progress' && this.s.spawns[t.owner]) {
      name = t.owner; // restart the worker that owns it (it crashed or gave up)
    } else throw new BusError(`#${t.id} is ${t.status}${t.owner ? ' (' + t.owner + ')' : ''} — spawn needs an open task`, 409);
    const w = this.#record(name, t, cleanName(who) || 'you');
    this.bus.log(`${w.by} asked for a worker on #${t.id}: ${name}`);
    this.pump();
    return w;
  }

  stop(who, name) {
    name = cleanName(name);
    const w = this.s.spawns[name];
    if (!w) throw new BusError(`no spawned worker "${name}"`, 404);
    if (!this.bus.isBossOf(who, w.team)) throw new BusError(`only ${this.bus.leadFor(w.team)}, the head or the human can stop ${name}`, 403);
    if (w.status === 'queued') Object.assign(w, { status: 'exited', note: 'cancelled' });
    else if (w.status === 'running') { w.note = `stopped by ${who}`; this.procs.get(name)?.kill(); }
    this.bus.log(`${name}: ${w.note || 'already exited'}`);
    this.bus.store.save();
    return w;
  }

  #newName(team) {
    for (let i = 1; ; i++) {
      const n = `${team}-${i}`;
      if (!this.s.agents[n] && !this.s.spawns[n]) return n;
    }
  }

  #record(name, t, by, reason = '') {
    const w = (this.s.spawns[name] ??= { name, team: t.team, runs: 0 });
    Object.assign(w, { task: t.id, by, status: 'queued', reason, queuedAt: Date.now(), note: '' });
    this.bus.store.save();
    return w;
  }

  /** Start queued workers while slots are free and their task's dependencies are merged. */
  async pump() {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (this.running().length < this.max) {
          const next = this.list()
            .filter((w) => w.status === 'queued' && this.tasks.depsMet(this.tasks.get(w.task)))
            .sort((a, b) => a.queuedAt - b.queuedAt)[0];
          if (!next) break;
          next.status = 'starting'; // not picked twice, but not counted as running until it is
          try { await this.#start(next); }
          catch (e) {
            Object.assign(next, { status: 'exited', note: `could not start: ${e.message}` });
            this.bus.log(`${next.name} could not start: ${e.message}`);
            this.bus.notify(next.by, `couldn't start ${next.name} for #${next.task}: ${e.message}`);
          }
          this.bus.store.save();
        }
      } while (this.again);
    } finally { this.pumping = false; }
  }

  /** A respawn keeps the worktree it had (wherever it was made); a new worker gets <repo>.worktrees/<name>. */
  async #worktree(name) {
    const old = this.s.spawns[name]?.worktree;
    if (old && fs.existsSync(old)) return old;
    return addWorktree(this.repo, name, this.env);
  }

  // ---- worktrees for agents you start yourself (`bus worktree`), and pruning --------------------------

  /** Create a worktree + branch for an agent the human (or a lead) will start by hand. Idempotent. */
  async createWorktree(who, name, team) {
    name = cleanName(name);
    team = cleanName(team);
    if (!NAME_RE.test(name) || name === 'bus' || name === 'you') throw new BusError(`bad name "${name}" (use a-z 0-9 _ -)`);
    if (!team || !NAME_RE.test(team)) throw new BusError('usage: bus worktree <name> --team <team>');
    if (!this.bus.isBossOf(who, team)) throw new BusError(`only the human, the head or team ${team}'s lead can make worktrees for it`, 403);
    if (this.s.spawns[name]) throw new BusError(`${name} is a spawned worker — pick another name`, 409);
    const a = this.s.agents[name];
    if (a && a.team !== team) throw new BusError(`${name} is already on team ${a.team}`, 409);
    const rec = this.s.worktrees[name];
    if (rec && !rec.removed && fs.existsSync(rec.path)) return { ...rec, existed: true };
    const wt = await addWorktree(this.repo, name, this.env);
    this.s.worktrees[name] = { name, team, path: wt, by: cleanName(who) || 'you', createdAt: Date.now() };
    this.bus.log(`worktree for ${name} (${team}) created: ${wt}`);
    this.bus.store.save();
    return this.s.worktrees[name];
  }

  worktrees() {
    return { root: worktreeRoot(this.repo, this.env), manual: Object.values(this.s.worktrees).filter((r) => !r.removed),
      spawned: this.list().filter((w) => w.worktree && !w.cleaned).map(({ name, team, status, worktree }) => ({ name, team, status, path: worktree })) };
  }

  /**
   * Remove every bus-made worktree that is idle: its agent holds no task, it isn't running, and nothing happened in
   * it for PRUNE_GRACE_MS. Never loses work: dirty worktrees are kept, and unmerged branches stay (commits included).
   * Human or head only. dryRun lists what would go.
   */
  async prune(who, { dryRun = false, now = Date.now() } = {}) {
    if (!this.bus.isTop(who)) throw new BusError('only the human or the head can prune worktrees', 403);
    const cands = [
      ...this.list().filter((w) => w.worktree && !w.cleaned).map((rec) => ({ rec, kind: 'spawned', name: rec.name, path: rec.worktree, since: rec.endedAt ?? rec.startedAt ?? 0 })),
      ...Object.values(this.s.worktrees).filter((r) => !r.removed).map((rec) => ({ rec, kind: 'manual', name: rec.name, path: rec.path, since: rec.createdAt ?? 0 })),
    ];
    const gone = (c) => { if (c.kind === 'spawned') c.rec.cleaned = true; else c.rec.removed = true; };
    const out = [];
    for (const c of cands) {
      if (!fs.existsSync(c.path)) { if (!dryRun) gone(c); continue; } // removed by hand: just forget it
      const a = this.s.agents[c.name];
      const busy = c.kind === 'spawned' && c.rec.status !== 'exited' ? c.rec.status
        : a?.task ? `holds task #${a.task}`
        : now - Math.max(a?.lastSeen ?? 0, c.since) < PRUNE_GRACE_MS ? `active in the last ${PRUNE_GRACE_MS / 60000} min` : null;
      if (busy) { out.push({ name: c.name, path: c.path, kept: busy }); continue; }
      if (dryRun) { out.push({ name: c.name, path: c.path, wouldRemove: true }); continue; }
      const r = await removeWorktree(this.repo, c.path, c.name);
      if (r.removed) gone(c);
      out.push({ name: c.name, path: c.path, ...(r.removed ? r : { kept: r.reason }) });
    }
    if (!dryRun) {
      const n = out.filter((x) => x.removed).length;
      if (n) this.bus.log(`pruned ${n} worktree${n === 1 ? '' : 's'}`);
      this.bus.store.save();
    }
    return out;
  }

  #settingsFile() {
    const f = path.join(this.dataDir, 'worker-settings.json');
    const settings = {};
    mergeSettings(settings); // the same edit guard, shell guard and notice hooks `bus init` installs
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(settings, null, 2) + '\n');
    return f;
  }

  async #start(w) {
    const t = this.tasks.get(w.task);
    const wt = await this.#worktree(w.name);
    const a = this.bus.touch(w.name, w.team, wt); // registered now, so DMs reach it
    a.spawned = true;
    const logDir = path.join(this.dataDir, 'workers');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, `${w.name}.log`);
    const env = { ...this.env, BUS_AGENT: w.name, BUS_TEAM: w.team, BUS_SPAWNED: '1' }; // BUS_SPAWNED: no SessionStart rules
    delete env.BUS_ROLE;
    if (this.port && !env.BUS_URL) env.BUS_PORT = String(this.port);
    // Rejected and its session is known: resume it (it keeps what it learned) instead of starting cold.
    const resume = w.reason && w.session ? w.session : '';
    const prompt = resume ? resumePrompt({ task: t.id, reason: w.reason }) : workerPrompt({ name: w.name, team: w.team, task: t.id, reason: w.reason });
    let logStart = 0;
    try { logStart = fs.statSync(log).size; } catch { /* new log */ }
    const h = this.launcher({ cmd: this.env.BUS_CLAUDE || 'claude', args: workerArgs(prompt, this.#settingsFile(), this.env, { check: t.check, resume }), cwd: wt, env, log });
    this.procs.set(w.name, h);
    Object.assign(w, { status: 'running', pid: h.pid, worktree: wt, log, logStart, resumed: !!resume, startedAt: Date.now(), runs: (w.runs ?? 0) + 1 });
    this.bus.log(`${w.name} started for #${t.id} (${this.running().length}/${this.max} running)`);
    h.onExit((code, err) => this.#exited(w.name, code, err));
  }

  #exited(name, code, err) {
    const w = this.s.spawns[name];
    this.procs.delete(name);
    if (!w || w.status !== 'running') return;
    Object.assign(w, { status: 'exited', code, endedAt: Date.now(), ...(err && { note: err }) });
    const run = readRun(w.log, w.logStart);
    if (run.result) {
      if (run.result.session_id) w.session = run.result.session_id;
      if (typeof run.result.total_cost_usd === 'number') w.cost = Math.round(((w.cost ?? 0) + run.result.total_cost_usd) * 1e4) / 1e4;
    } else if (w.resumed) delete w.session; // the resume failed (session gone?): next spawn starts fresh
    const t = this.s.tasks.find((x) => x.id === w.task);
    this.bus.log(`${name} exited (code ${code}) — #${w.task} ${t?.status ?? '?'}`);
    // Only worth a lead's tokens when the worker stopped without handing its task in. The tail of what it said
    // comes along, so the lead doesn't have to open the whole log to see why.
    const unfinished = t && (t.status === 'open' || (t.status === 'in_progress' && t.owner === name));
    if (unfinished && !/^stopped by/.test(w.note ?? '')) {
      this.bus.notify(this.tasks.reviewer(t), `${name} exited with #${t.id} unfinished${run.tail ? ` — last words: ${run.tail}` : ''} (log: ${w.log}) — bus spawn ${t.id} to retry, or bus task reassign ${t.id} <agent>`);
    }
    this.bus.store.save();
    if (t?.status === 'merged') this.cleanup(name).catch(() => {}); // merged while it was still running
    this.pump();
  }

  /**
   * After a spawned worker's task merges, remove its worktree and branch (the bus made them, so the bus cleans up).
   * Only a worktree with nothing uncommitted (the bus's own .bus/ aside) is removed; the branch is deleted with
   * `git branch -d`, which refuses unless it is merged. Anything that can't be removed is left and logged.
   */
  async cleanup(name) {
    const w = this.s.spawns[name];
    if (!w || w.status !== 'exited' || w.cleaned || !w.worktree || !fs.existsSync(w.worktree)) return false;
    const r = await removeWorktree(this.repo, w.worktree, name);
    if (!r.removed) { this.bus.log(`${name}: worktree kept (${r.reason}) — ${w.worktree}`); return false; }
    w.cleaned = true;
    this.bus.log(`${name}: worktree removed${r.branchDeleted ? ', branch deleted' : ` (branch kept: ${r.branchNote})`}`);
    this.bus.store.save();
    return true;
  }

  #onTask({ type, task: t, why }) {
    const w = t.owner && this.s.spawns[t.owner];
    if (type === 'merged' && w) this.cleanup(t.owner).catch((e) => this.bus.log(`${t.owner}: cleanup failed: ${e.message}`));
    if (type === 'rejected' && w && w.status === 'exited') {
      this.#record(t.owner, t, w.by, why);
      this.bus.log(`${t.owner} re-queued for rejected #${t.id}`);
    } else if (type === 'dropped' || type === 'reassigned') {
      for (const q of this.list()) if (q.status === 'queued' && q.task === t.id) Object.assign(q, { status: 'exited', note: type });
    }
    this.pump(); // a merge may unblock queued dependents; a rejection may have re-queued one
  }

  close() { for (const h of this.procs.values()) h.kill(); }
}
