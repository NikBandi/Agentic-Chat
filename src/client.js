// Minimal HTTP client used by the CLI and hooks. node:http (not fetch) so long waits have no client timeout.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_PORT } from './server.js';
import { cleanName } from './bus.js';
import { readHumanToken } from './human.js';

export const baseUrl = () => process.env.BUS_URL || `http://127.0.0.1:${process.env.BUS_PORT || DEFAULT_PORT}`;

export class NotRunning extends Error {}

/** BUS_AUTH token file for an agent inside a worktree: <root>/.bus/agents/<name>.token */
export const tokenFile = (root, name) => path.join(root, '.bus', 'agents', `${cleanName(name)}.token`);

/** Nearest .bus/agents/<BUS_AGENT>.token at or above cwd, or null. */
export function findToken(start = process.cwd()) {
  if (!process.env.BUS_AGENT) return null;
  let dir = path.resolve(start);
  for (;;) {
    try { return fs.readFileSync(tokenFile(dir, process.env.BUS_AGENT), 'utf8').trim() || null; } catch { /* keep looking */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function identity(extra = {}) {
  const h = {};
  if (process.env.BUS_AGENT) h['x-bus-agent'] = encodeURIComponent(process.env.BUS_AGENT);
  if (process.env.BUS_TEAM) h['x-bus-team'] = encodeURIComponent(process.env.BUS_TEAM);
  const token = findToken();
  if (token) h['x-bus-token'] = encodeURIComponent(token);
  if (!process.env.BUS_AGENT) { // the human: prove it with the token bus serve wrote outside the repo
    const human = readHumanToken(new URL(baseUrl()).port || '80');
    if (human) h['x-bus-human'] = encodeURIComponent(human);
  }
  for (const [k, v] of Object.entries(extra)) if (v) h[k] = encodeURIComponent(v);
  return h;
}

/** Returns parsed JSON. Throws NotRunning if the server is down, Error(msg) with .status on HTTP errors. */
export function request(method, path, { body, query, headers = {}, timeoutMs = 0 } = {}) {
  const url = new URL(path, baseUrl());
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { ...identity(), ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { data = {}; }
        if (res.statusCode >= 400) {
          const err = new Error(data.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(data);
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new NotRunning('bus server did not respond')));
    req.on('error', (e) => reject(e instanceof NotRunning || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'].includes(e.code) ? new NotRunning('bus server not running — start it with: bus serve') : e));
    if (payload) req.write(payload);
    req.end();
  });
}
