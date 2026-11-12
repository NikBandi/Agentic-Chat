// Lead-spawned workers: `bus spawn <task>` makes a git worktree and starts a headless Claude Code worker that sees
// only that task. At most BUS_MAX_WORKERS (default 4) run at once across the whole bus; extra spawns queue and start
// as slots free up. A worker exits once its task passes its check (no idle sessions); a rejected task re-spawns it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as cpSpawn, execFile } from 'node:child_process';
import { BusError, cleanName } from './bus.js';
import { git, mainBranch } from './check.js';
import { mergeSettings } from './init.js';

export const DEFAULT_MAX = 4;
export const maxWorkers = (env = process.env) => Math.min(Math.max(1, Number(env.BUS_MAX_WORKERS) || DEFAULT_MAX), 16);

/** The worker's whole instruction set: short, because every worker pays for it. */
export function workerPrompt({ name, team, task, reason = '' }) {
  return [
    `You are ${name}, a worker on team ${team}, in your own git worktree. Your only job is task #${task}.`,
    reason && `It was sent back: ${reason}. Fix that.`,
    `1. bus join   2. bus task take ${task} (prints the brief: it is your full context; also read docs it names)`,
    `3. Do the work (tests first), commit on your branch.`,
    `4. bus task done ${task} --report "<what you built; problems; anything unfinished — max 3 lines>". If the check fails, fix and rerun.`,
    `When bus task done says the check passed, stop: you are finished. Blocked on someone? bus send @<agent> "..." then bus wait.`,
  ].filter(Boolean).join('\n');
}

/** argv for the worker process (model, budget and permission mode from env). */
export function workerArgs(prompt, settingsFile, env = process.env) {
  const args = ['-p', prompt, '--settings', settingsFile, '--permission-mode', env.BUS_WORKER_PERMISSION || 'bypassPermissions'];
  if (env.BUS_WORKER_MODEL) args.push('--model', env.BUS_WORKER_MODEL);
  if (env.BUS_WORKER_BUDGET) args.push('--max-budget-usd', String(env.BUS_WORKER_BUDGET));
  return args;
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
   * repo: the main checkout (worktrees go next to it as <repo>-<agent>). dataDir: logs and worker settings.
   * launcher: injectable for tests. Lifecycle per worker: queued -> running -> exited (re-queued on reject).
   */
  constructor(bus, tasks, { repo = process.cwd(), dataDir = null, launcher = launch, env = process.env, port = null } = {}) {
    Object.assign(this, { bus, tasks, repo, launcher, env, port });
    this.dataDir = dataDir || path.join(repo, '.bus');
    this.s = bus.s;
    this.s.spawns ??= {};
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

  async #worktree(name) {
    const wt = path.join(path.dirname(this.repo), `${path.basename(this.repo)}-${name}`);
    if (fs.existsSync(wt)) return wt; // respawn: keep its branch and commits
    const main = await mainBranch(this.repo);
    const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], this.repo)).code === 0;
    const r = await git(exists ? ['worktree', 'add', wt, name] : ['worktree', 'add', '-b', name, wt, main], this.repo);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err.split('\n')[0]}`);
    return wt;
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
    const env = { ...this.env, BUS_AGENT: w.name, BUS_TEAM: w.team, ECC_HOOK_PROFILE: this.env.ECC_HOOK_PROFILE || 'minimal' };
    delete env.BUS_ROLE;
    if (this.port && !env.BUS_URL) env.BUS_PORT = String(this.port);
    const prompt = workerPrompt({ name: w.name, team: w.team, task: t.id, reason: w.reason });
    const h = this.launcher({ cmd: this.env.BUS_CLAUDE || 'claude', args: workerArgs(prompt, this.#settingsFile(), this.env), cwd: wt, env, log });
    this.procs.set(w.name, h);
    Object.assign(w, { status: 'running', pid: h.pid, worktree: wt, log, startedAt: Date.now(), runs: (w.runs ?? 0) + 1 });
    this.bus.log(`${w.name} started for #${t.id} (${this.running().length}/${this.max} running)`);
    h.onExit((code, err) => this.#exited(w.name, code, err));
  }

  #exited(name, code, err) {
    const w = this.s.spawns[name];
    this.procs.delete(name);
    if (!w || w.status !== 'running') return;
    Object.assign(w, { status: 'exited', code, endedAt: Date.now(), ...(err && { note: err }) });
    const t = this.s.tasks.find((x) => x.id === w.task);
    this.bus.log(`${name} exited (code ${code}) — #${w.task} ${t?.status ?? '?'}`);
    // Only worth a lead's tokens when the worker stopped without handing its task in.
    const unfinished = t && (t.status === 'open' || (t.status === 'in_progress' && t.owner === name));
    if (unfinished && !/^stopped by/.test(w.note ?? '')) {
      this.bus.notify(this.tasks.reviewer(t), `${name} exited with #${t.id} unfinished (log: ${w.log}) — bus spawn ${t.id} to retry, or bus task reassign ${t.id} <agent>`);
    }
    this.bus.store.save();
    this.pump();
  }

  #onTask({ type, task: t, why }) {
    const w = t.owner && this.s.spawns[t.owner];
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
