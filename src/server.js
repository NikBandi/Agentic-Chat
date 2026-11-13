// Local HTTP server (127.0.0.1 only). Identity comes from x-bus-agent / x-bus-team / x-bus-cwd headers;
// no x-bus-agent means the human ("you").
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus, BusError, HUMAN, cleanName } from './bus.js';
import { Store } from './store.js';
import { Tasks } from './tasks.js';
import { Spawner } from './spawn.js';
import { DEFAULT_PORT } from './constants.js';

export { DEFAULT_PORT };
const MAX_BODY = 256 * 1024;
const MAX_WAIT_S = 3600;

export function createServer({
  dataFile = null, port = DEFAULT_PORT, host = '127.0.0.1',
  inactiveMs = (Number(process.env.BUS_INACTIVE_MIN) || 30) * 60_000,
  repoDir = process.cwd(), // merges are verified here when the merger's worktree is unknown
  auth = process.env.BUS_AUTH === '1', // per-agent tokens + human token (off by default)
  humanToken = crypto.randomBytes(24).toString('base64url'), // `bus serve` writes it to ~/.agentic-chat/<port>.human.token
  launcher, // tests: replaces starting real `claude -p` workers
  env = process.env,
} = {}) {
  const store = new Store(dataFile);
  const bus = new Bus(store);
  const tasks = new Tasks(bus, { repo: repoDir, reportsFile: dataFile ? path.join(path.dirname(dataFile), 'reports.md') : null });
  bus.s.tokens ??= {}; // agent -> sha256(token); never served
  const spawner = new Spawner(bus, tasks, { repo: repoDir, dataDir: dataFile ? path.dirname(dataFile) : null, env, port, ...(launcher && { launcher }) });

  /** BUS_AUTH: an agent with a token must present it; an agent without one may only join (and gets one). */
  function authenticate(who, req, isJoin) {
    if (!auth || who === HUMAN) return;
    const want = bus.s.tokens[who];
    if (!want) {
      if (isJoin) return;
      throw new BusError(`auth on — run bus join from your worktree first`, 401);
    }
    const got = crypto.createHash('sha256').update(hdr(req, 'x-bus-token')).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      throw new BusError(`bad or missing token for ${who} — run bus from the worktree that joined, or ask the human: bus auth reset ${who}`, 401);
    }
  }
  /** BUS_AUTH: an identity-less caller is the human only with the human token. */
  const sameSecret = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  function requireHuman(given) {
    if (!auth || sameSecret(given, humanToken)) return;
    throw new BusError('human token required — open the dashboard link bus serve printed, or run bus where ~/.agentic-chat is readable', 401);
  }
  function issueToken(who) {
    if (!auth || who === HUMAN || bus.s.tokens[who]) return undefined;
    const token = crypto.randomBytes(24).toString('base64url');
    bus.s.tokens[who] = crypto.createHash('sha256').update(token).digest('hex');
    store.save();
    return token;
  }
  const waiters = new Map(); // agent -> Set<fn>

  // Dashboard live updates (SSE). Any state change -> one debounced "change" event; clients refetch /api/state.
  const sse = new Set();
  let changeTimer = null;
  const changed = () => {
    if (!sse.size || changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      for (const res of sse) res.write(`event: change\ndata: ${bus.s.seq}\n\n`);
    }, 100);
  };
  store.onChange = changed;
  const heartbeat = setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 25_000);
  heartbeat.unref();

  // Inactivity: agents blocked in `bus wait` are busy, not silent.
  const sweeper = setInterval(() => bus.sweep(inactiveMs, new Set(waiters.keys())), Math.min(60_000, inactiveMs));
  sweeper.unref();

  bus.on('message', () => {
    for (const [name, set] of waiters) {
      if (bus.s.agents[name] && bus.pending(name) > 0) for (const fn of [...set]) fn();
    }
  });

  const routes = {
    'POST /api/join': ({ who, me }) => ({ agent: me, token: issueToken(who) }),
    'POST /api/auth/reset': ({ who, body }) => {
      if (who !== HUMAN) throw new BusError('only the human can reset a token', 403);
      const name = cleanName(body.agent);
      const had = !!bus.s.tokens[name];
      delete bus.s.tokens[name];
      bus.log(`token reset for ${name}`);
      store.save();
      return { agent: name, reset: had };
    },
    'GET /api/who': () => ({ agents: bus.who() }),
    'POST /api/send': ({ who, body }) => ({ message: bus.send(who, body.to, body.text) }),
    'POST /api/read': ({ who }) => bus.read(need(who)),
    'GET /api/pending': ({ who }) => ({ pending: bus.pending(need(who)) }),
    'GET /api/notice': ({ who }) => ({ notice: bus.notice(need(who)) }),
    'GET /api/show': ({ q }) => ({ message: bus.show(q.get('id')) }),
    'GET /api/log': ({ who, q }) => bus.channelLog(who, q.get('channel'), q.get('n')),
    'POST /api/claim': ({ who, body }) => bus.claim(need(who), arr(body.paths), body.why),
    'POST /api/release': ({ who, body }) => (body.of
      ? bus.releaseOf(who, body.of, arr(body.paths), !!body.all)
      : bus.release(need(who), arr(body.paths), !!body.all)),
    'GET /api/claims': ({ who, q }) => ({ claims: bus.claims(q.get('mine') ? who : null) }),
    'GET /api/check': ({ who, q }) => bus.check(who, q.get('path') || '', { editing: !!q.get('edit') }),
    'POST /api/usage': ({ who, body }) => bus.recordUsage(need(who), body.session, body),
    'GET /api/usage': () => ({
      agents: Object.values(bus.s.agents).filter((a) => a.usage).map(({ name, team, usage }) => ({ name, team, usage })),
      tasks: bus.s.tasks.filter((t) => t.usage).map(({ id, title, status, usage }) => ({ id, title, status, usage })),
    }),
    'GET /api/hot':() => ({ hotFiles: bus.s.hotFiles }), // small reads so the CLI never pulls the whole state
    'GET /api/iface': () => ({ interfaces: bus.s.interfaces }),
    'POST /api/hot':({ who, body }) => ({ hotFiles: body.rm ? bus.hotRm(who, arr(body.paths)) : bus.hotAdd(who, arr(body.paths)) }),
    'POST /api/request': ({ who, body }) => ({ request: bus.request(need(who), body.file, body.text) }),
    'POST /api/request/resolve': ({ who, body }) => ({ request: bus.resolveRequest(who, body.id, body.verdict, body.why) }),
    'POST /api/iface': ({ who, body }) => ({ interfaces: body.rm ? bus.ifaceRm(who, body.path) : bus.ifaceAdd(who, body.path, arr(body.teams)) }),
    // `waiting` is live (who is blocked in bus wait right now), never persisted.
    'GET /api/state': () => ({ ...bus.s, tokens: undefined, agents: Object.fromEntries(Object.entries(bus.s.agents).map(([n, a]) => [n, waiters.has(n) ? { ...a, waiting: true } : a])) }),
    'POST /api/wait': waitRoute,
    'POST /api/task/add': ({ who, body }) => ({ task: tasks.add(who, { ...body, files: arr(body.files), context: arr(body.context), after: arr(body.after) }) }),
    'GET /api/task/list': ({ who, q }) => ({ tasks: tasks.list(who, !!q.get('mine')) }),
    'GET /api/task/show': ({ q }) => ({ task: tasks.get(q.get('id')) }),
    'POST /api/task/take': ({ who, body }) => {
      const task = tasks.take(need(who), body.id);
      return { task, notes: bus.notesFor([...task.files, ...(task.context ?? [])]) }; // shown with the brief: no extra calls
    },
    'POST /api/note': ({ who, body }) => ({ note: body.rm ? bus.noteRm(who, body.path) : bus.noteAdd(need(who), body.path, body.text) }),
    'GET /api/note': ({ q }) => ({ note: bus.note(q.get('path') || '') }),
    'GET /api/notes': () => ({ notes: bus.notes().map(({ path: p, by, ts }) => ({ path: p, by, ts })) }),
    'POST /api/task/done': ({ who, body }) => tasks.done(need(who), body.id, body.summary, { allowDirty: !!body.allowDirty, report: body.report }),
    'GET /api/task/report': ({ who, q }) => ({ report: tasks.report(who, q.get('id')) }),
    'POST /api/task/merged': async ({ who, body }) => ({ task: await tasks.merged(who, body.id, { force: !!body.force }) }),
    'POST /api/task/reassign': ({ who, body }) => ({ task: tasks.reassign(who, body.id, body.to) }),
    'POST /api/task/drop': ({ who, body }) => ({ task: tasks.drop(who, body.id) }),
    'POST /api/spawn': ({ who, body }) => ({ worker: spawner.request(who, body.id), running: spawner.running().length, max: spawner.max }),
    'POST /api/spawn/stop': ({ who, body }) => ({ worker: spawner.stop(who, body.name) }),
    'POST /api/worktree': async ({ who, body }) => ({ worktree: await spawner.createWorktree(who, body.name, body.team) }),
    'POST /api/worktree/prune': async ({ who, body }) => ({ results: await spawner.prune(who, { dryRun: !!body.dryRun }) }),
    'GET /api/worktrees': () => spawner.worktrees(),
    'GET /api/workers':() => ({ workers: spawner.list(), running: spawner.running().length, max: spawner.max }),
    'POST /api/approve': ({ who, body }) => ({ task: tasks.approve(who, body.id) }),
    'POST /api/reject': ({ who, body }) => ({ task: tasks.reject(who, body.id, body.why) }),
  };

  function waitRoute({ who, q, res }) {
    const name = need(who);
    const secs = Math.min(Math.max(1, Number(q.get('secs')) || 110), MAX_WAIT_S);
    if (bus.pending(name) > 0) return bus.read(name);
    return new Promise((resolve) => {
      const set = waiters.get(name) ?? new Set();
      if (!waiters.has(name)) { waiters.set(name, set); changed(); }
      const done = (result) => {
        clearTimeout(timer);
        set.delete(fire);
        if (!set.size && waiters.get(name) === set) { waiters.delete(name); changed(); }
        resolve(result);
      };
      const fire = () => done(bus.read(name));
      const timer = setTimeout(() => done({ messages: [], skipped: 0, timeout: true }), secs * 1000);
      set.add(fire);
      res.on('close', () => { if (!res.writableEnded) done(null); });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        if (req.method === 'GET' && url.pathname === '/') return send(res, 200, dashboardHtml(), 'text/html');
        if (req.method === 'GET' && url.pathname === '/api/events') {
          requireHuman(url.searchParams.get('t')); // EventSource can't send headers: token rides in ?t=
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(`event: change\ndata: ${bus.s.seq}\n\n`);
          sse.add(res);
          req.on('close', () => sse.delete(res));
          return;
        }
        throw new BusError(`no route ${req.method} ${url.pathname}`, 404);
      }
      const who = cleanName(hdr(req, 'x-bus-agent')) || HUMAN; // naming yourself "you" is the same as no name
      if (who === HUMAN) requireHuman(hdr(req, 'x-bus-human'));
      authenticate(who, req, url.pathname === '/api/join'); // before touch(): unproven agents aren't registered
      const me = who === HUMAN ? null : bus.touch(who, hdr(req, 'x-bus-team'), hdr(req, 'x-bus-cwd'), hdr(req, 'x-bus-role'));
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await route({ who, me, body, q: url.searchParams, req, res });
      if (out !== null && !res.writableEnded) send(res, 200, out);
    } catch (e) {
      const status = e instanceof BusError ? e.status : 500;
      if (!res.writableEnded) send(res, status, { error: e.message });
    }
  });
  server.requestTimeout = 0; // long-polling `bus wait`
  server.headersTimeout = 30_000;

  return {
    bus, tasks, spawner, store, server, humanToken,
    listen: () => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server.address().port)); }),
    close: () => new Promise((ok) => { spawner.close(); clearInterval(heartbeat); clearInterval(sweeper); clearTimeout(changeTimer); for (const r of sse) r.end(); store.flush(); server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

const DASHBOARD = fileURLToPath(new URL('./dashboard.html', import.meta.url));
function dashboardHtml() { // read per request so UI edits show up on reload
  try { return fs.readFileSync(DASHBOARD, 'utf8'); }
  catch { return '<!doctype html><title>bus</title><p>Agentic Chat bus is running. Dashboard file missing.</p>'; }
}

function need(who) {
  if (who === HUMAN) throw new BusError('BUS_AGENT is not set — this command needs an agent identity', 400);
  return who;
}
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const hdr = (req, k) => { const v = req.headers[k]; return v ? decodeURIComponent(v) : ''; };

function send(res, status, data, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new BusError('body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new BusError('bad JSON')); }
    });
    req.on('error', fail);
  });
}
