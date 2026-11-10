#!/usr/bin/env node
// `bus` CLI. Output is deliberately terse: one line per item, no decoration (agents pay for every token).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from '../src/client.js';
import { createServer, DEFAULT_PORT } from '../src/server.js';

const TRUNC = 200;

const HELP = `bus — local agent chat, claims and tasks
  bus serve [--port N] [--data FILE]    start server (default 127.0.0.1:${DEFAULT_PORT}, .bus/state.json)
  bus init [project]                    add hooks + agent rules to a project
  bus join                              register (BUS_AGENT, BUS_TEAM env)
  bus who                               list agents
  bus send [#chan|@agent|@team] text    post (default: your team channel)
  bus read                              unread messages addressed to you
  bus wait [secs]                       block until something arrives (default 110)
  bus show <id>                         full text of a message
  bus log [#chan] [n]                   read a channel (no #chan: your DMs)
  bus claim <paths...> [-m why]         claim files / dirs/ / globs
  bus release <paths...> | --all
  bus claims [--mine]
  bus check <path>                      is a file free for you to edit?
  bus pending                           count of unread messages`;

function fmt(m) {
  let t = m.text.replace(/\s*\n\s*/g, ' ⏎ ');
  if (t.length > TRUNC) t = t.slice(0, TRUNC) + `… (bus show ${m.id})`;
  return `${m.id} ${m.from}>${m.channel ?? '@' + m.to}: ${t}`;
}

function printList({ messages, skipped, timeout }, empty) {
  if (skipped) console.log(`(${skipped} older skipped)`);
  if (!messages.length) console.log(timeout ? 'nothing yet' : empty);
  for (const m of messages) console.log(fmt(m));
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

function takeFlag(args, name, hasValue = false) {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? undefined : false;
  const v = hasValue ? args[i + 1] : true;
  args.splice(i, hasValue ? 2 : 1);
  return v;
}

function gitRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return process.cwd(); }
}

const commands = {
  async serve(args) {
    const port = Number(takeFlag(args, '--port', true) || process.env.BUS_PORT || DEFAULT_PORT);
    const dataFile = path.resolve(takeFlag(args, '--data', true) || process.env.BUS_DATA || '.bus/state.json');
    const srv = createServer({ port, dataFile });
    const p = await srv.listen();
    console.log(`bus listening on http://127.0.0.1:${p} (data: ${dataFile})`);
    const stop = async () => { await srv.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },

  async join() {
    if (!process.env.BUS_AGENT) throw new Error('set BUS_AGENT (and BUS_TEAM) first');
    const { agent } = await request('POST', '/api/join', { headers: { 'x-bus-cwd': gitRoot() } });
    console.log(`joined as ${agent.name} (team ${agent.team})`);
  },

  async who() {
    const { agents } = await request('GET', '/api/who');
    if (!agents.length) return console.log('no agents');
    for (const a of agents) console.log(`${a.name} ${a.team} task:${a.task ?? '-'} seen:${ago(a.lastSeen)}`);
  },

  async send(args) {
    let to = '';
    if (args[0] && /^[#@]/.test(args[0])) to = args.shift();
    const { message } = await request('POST', '/api/send', { body: { to, text: args.join(' ') } });
    console.log(`sent ${message.id}`);
  },

  async read() { printList(await request('POST', '/api/read'), 'no new messages'); },

  async wait(args) {
    const secs = Number(args[0]) || 110;
    printList(await request('POST', '/api/wait', { query: { secs } }), 'no new messages');
  },

  async show(args) {
    const { message: m } = await request('GET', '/api/show', { query: { id: args[0] } });
    console.log(`${m.id} ${m.from}>${m.channel ?? '@' + m.to} ${new Date(m.ts).toISOString()}\n${m.text}`);
  },

  async log(args) {
    const channel = args[0]?.startsWith('#') ? args.shift() : '';
    printList(await request('GET', '/api/log', { query: { channel, n: args[0] } }), 'no messages');
  },

  async claim(args) {
    const why = takeFlag(args, '-m', true) || '';
    const r = await request('POST', '/api/claim', { body: { paths: args, why } });
    if (r.ok) return console.log(`claimed ${r.claimed.join(' ')}`);
    for (const c of r.conflicts) console.log(`blocked: ${c.path} overlaps ${c.claim} held by ${c.owner} — ask: bus send @${c.owner} "..."`);
    process.exitCode = 1;
  },

  async release(args) {
    const all = takeFlag(args, '--all');
    const r = await request('POST', '/api/release', { body: { paths: args, all } });
    console.log(r.released ? `released ${r.paths.join(' ')}` : 'nothing released');
  },

  async claims(args) {
    const mine = takeFlag(args, '--mine');
    const { claims } = await request('GET', '/api/claims', { query: { mine: mine ? 1 : '' } });
    if (!claims.length) return console.log('no claims');
    for (const c of claims) console.log(`${c.path} ${c.agent}${c.why ? ' — ' + c.why : ''}`);
  },

  async check(args) {
    const r = await request('GET', '/api/check', { query: { path: args[0] } });
    if (r.free) console.log(r.mine ? 'free (yours)' : 'free');
    else { console.log(`claimed by ${r.owner} (${r.claim})`); process.exitCode = 1; }
  },

  async pending() { console.log((await request('GET', '/api/pending')).pending); },

  async init(args) {
    const { init } = await import('../src/init.js');
    for (const line of init(args[0] || process.cwd())) console.log(line);
  },

  async hook([sub]) {
    const hooks = await import('../src/hooks.js');
    const fn = { pre: hooks.preEdit }[sub];
    if (!fn) throw new Error(`unknown hook "${sub}"`);
    process.exit(await fn());
  },

  help() { console.log(HELP); },
};

async function main([cmd = 'help', ...args]) {
  const fn = commands[cmd] || (['-h', '--help'].includes(cmd) ? commands.help : null);
  if (!fn) { console.error(`bus: unknown command "${cmd}" — bus help`); process.exit(2); }
  try { await fn(args); }
  catch (e) { console.error(`bus: ${e.message}`); process.exit(1); }
}

main(process.argv.slice(2));
