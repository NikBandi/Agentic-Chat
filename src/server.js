// Local HTTP server (127.0.0.1 only). Identity comes from x-bus-agent / x-bus-team / x-bus-cwd headers;
// no x-bus-agent means the human ("you").
import http from 'node:http';
import { Bus, BusError, HUMAN, cleanName } from './bus.js';
import { Store } from './store.js';

export const DEFAULT_PORT = 4477;
const MAX_BODY = 256 * 1024;
const MAX_WAIT_S = 3600;

export function createServer({ dataFile = null, port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const store = new Store(dataFile);
  const bus = new Bus(store);
  const waiters = new Map(); // agent -> Set<fn>

  bus.on('message', () => {
    for (const [name, set] of waiters) {
      if (bus.s.agents[name] && bus.pending(name) > 0) for (const fn of [...set]) fn();
    }
  });

  const routes = {
    'POST /api/join': ({ me }) => ({ agent: me }),
    'GET /api/who': () => ({ agents: bus.who() }),
    'POST /api/send': ({ who, body }) => ({ message: bus.send(who, body.to, body.text) }),
    'POST /api/read': ({ who }) => bus.read(need(who)),
    'GET /api/pending': ({ who }) => ({ pending: bus.pending(need(who)) }),
    'GET /api/show': ({ q }) => ({ message: bus.show(q.get('id')) }),
    'GET /api/log': ({ who, q }) => bus.channelLog(who, q.get('channel'), q.get('n')),
    'POST /api/claim': ({ who, body }) => bus.claim(need(who), arr(body.paths), body.why),
    'POST /api/release': ({ who, body }) => bus.release(need(who), arr(body.paths), !!body.all),
    'GET /api/claims': ({ who, q }) => ({ claims: bus.claims(q.get('mine') ? who : null) }),
    'GET /api/check': ({ who, q }) => bus.check(who, q.get('path') || ''),
    'GET /api/state': () => bus.s,
    'POST /api/wait': waitRoute,
  };

  function waitRoute({ who, q, res }) {
    const name = need(who);
    const secs = Math.min(Math.max(1, Number(q.get('secs')) || 110), MAX_WAIT_S);
    if (bus.pending(name) > 0) return bus.read(name);
    return new Promise((resolve) => {
      const set = waiters.get(name) ?? new Set();
      waiters.set(name, set);
      const done = (result) => {
        clearTimeout(timer);
        set.delete(fire);
        if (!set.size) waiters.delete(name);
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
        if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'Agentic Chat bus is running. Dashboard: coming in build step 6.\n', 'text/plain');
        throw new BusError(`no route ${req.method} ${url.pathname}`, 404);
      }
      const who = cleanName(hdr(req, 'x-bus-agent')) || HUMAN;
      const me = who === HUMAN ? null : bus.touch(who, hdr(req, 'x-bus-team'), hdr(req, 'x-bus-cwd'));
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
    bus, store, server,
    listen: () => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server.address().port)); }),
    close: () => new Promise((ok) => { store.flush(); server.closeAllConnections?.(); server.close(() => ok()); }),
  };
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
