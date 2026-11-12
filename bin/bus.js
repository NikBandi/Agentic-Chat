#!/usr/bin/env node
// `bus` CLI. Output is deliberately terse: one line per item, no decoration (agents pay for every token).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { request, tokenFile, baseUrl } from '../src/client.js';
import { writeHumanToken, removeHumanToken, readHumanToken, humanTokenFile, openCommand } from '../src/human.js';
import { createServer, DEFAULT_PORT } from '../src/server.js';

const TRUNC = 200;

const HELP = `bus — local agent chat, claims and tasks
  bus serve [--port N] [--data FILE]    start server (default 127.0.0.1:${DEFAULT_PORT}, .bus/state.json)
  bus init [project]                    add hooks + agent rules to a project
  bus join                              register (BUS_AGENT, BUS_TEAM, BUS_ROLE=lead|head env)
  bus who                               list agents
  bus send [#chan|@agent|@team] text    post (default: your team channel)
  bus read                              unread messages addressed to you
  bus wait [secs]                       block until something arrives (default 110)
  bus show <id>                         full text of a message
  bus log [#chan] [n]                   read a channel (no #chan: your DMs)
  bus claim <paths...> [-m why]         claim files / dirs/ / globs
  bus release <paths...> | --all        [--of agent: human, or its lead/head if agent inactive]
  bus request <hot-file> "change"       ask the head to change a hot file
  bus request done|decline <id> ["why"] (head)
  bus hot add|rm <paths...> | list      head-owned shared files            (head/human)
  bus iface add <path> --teams a,b | rm <path> | list                     (head/human)
  bus claims [--mine]
  bus check <path>                      is a file free for you to edit?
  bus pending                           count of unread messages
  bus task add "title" --files a,b/ --check "cmd" [--after 3,4] [--for agent|team] [--team t]
               [--brief "text" | --brief-file f] [--timeout secs]          (lead: own team; head)
  bus task list [--mine] | show <id> | take <id>
  bus task done <id> ["summary"] [--report "≤3 lines"] [--allow-dirty]  commit first; runs the done-check -> merge request
  bus report <id>                       the task's report (its lead/head/human)
  bus task merged <id> [--force]        (its lead/head) after merging; verifies the commit is in main
  bus task reassign <id> <agent> | drop <id>                    (its lead/head/human)
  bus spawn <ids...>                    start a headless worker per task (own worktree; max BUS_MAX_WORKERS=4 at once, rest queue)  (lead/head)
  bus workers [stop <name>]             spawned workers: running/queued/exited
  bus approve <id> | bus reject <id> "why"                      (human)
  bus auth reset <agent>                drop an agent's token (BUS_AUTH=1)  (human)
  bus dashboard [--no-open]             print + open the dashboard link with your token  (human)`;

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
    writeHumanToken(p, srv.humanToken);
    console.log(`bus listening on http://127.0.0.1:${p} (data: ${dataFile})`);
    console.log(`dashboard: http://127.0.0.1:${p}/#t=${srv.humanToken}`);
    const stop = async () => { removeHumanToken(p, srv.humanToken); await srv.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },

  async join() {
    if (!process.env.BUS_AGENT) throw new Error('set BUS_AGENT (and BUS_TEAM) first');
    const root = gitRoot();
    const { agent, token } = await request('POST', '/api/join', { headers: { 'x-bus-cwd': root } });
    if (token) { // BUS_AUTH=1: keep the token in this worktree, git-ignored
      const fs = await import('node:fs');
      const file = tokenFile(root, agent.name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const ignore = path.join(root, '.bus', '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      fs.writeFileSync(file, token + '\n', { mode: 0o600 });
    }
    console.log(`joined as ${agent.name} (team ${agent.team}${agent.role && agent.role !== 'worker' ? ', ' + agent.role : ''})`);
  },

  async who() {
    const { agents } = await request('GET', '/api/who');
    if (!agents.length) return console.log('no agents');
    for (const a of agents) console.log(`${a.name} ${a.team}${a.role && a.role !== 'worker' ? ' ' + a.role : ''} task:${a.task ?? '-'} seen:${ago(a.lastSeen)}`);
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
    for (const c of r.conflicts) {
      console.log(c.hot
        ? `blocked: ${c.path} overlaps hot file ${c.claim} (${c.owner}) — ask: bus request ${c.claim} "..."`
        : `blocked: ${c.path} overlaps ${c.claim} held by ${c.owner} — ask: bus send @${c.owner} "..."`);
    }
    process.exitCode = 1;
  },

  async release(args) {
    const all = takeFlag(args, '--all');
    const of = takeFlag(args, '--of', true);
    const r = await request('POST', '/api/release', { body: { paths: args, all, of } });
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

  async task([sub, ...args]) {
    const fn = taskCommands[sub];
    if (!fn) throw new Error(`usage: bus task add|list|show|take|done|merged|reassign|drop — got "${sub ?? ''}"`);
    await fn(args);
  },

  async hot([sub, ...paths]) {
    if (sub === 'list' || !sub) {
      const { hotFiles } = await request('GET', '/api/state');
      return console.log(hotFiles.length ? hotFiles.join('\n') : 'no hot files');
    }
    if (!['add', 'rm'].includes(sub)) throw new Error('usage: bus hot add|rm <paths...> | bus hot list');
    const { hotFiles } = await request('POST', '/api/hot', { body: { paths, rm: sub === 'rm' } });
    console.log(`hot: ${hotFiles.join(' ') || '-'}`);
  },

  async request(args) {
    if (['done', 'decline'].includes(args[0])) {
      const [verdict, id, ...why] = args;
      const { request: r } = await request('POST', '/api/request/resolve', { body: { id, verdict, why: why.join(' ') } });
      return console.log(`r${r.id} ${r.status} — ${r.agent} notified`);
    }
    const [file, ...text] = args;
    const { request: r } = await request('POST', '/api/request', { body: { file, text: text.join(' ') } });
    console.log(`sent request r${r.id} to the head`);
  },

  async iface([sub, p, ...rest]) {
    if (sub === 'list' || !sub) {
      const { interfaces } = await request('GET', '/api/state');
      if (!interfaces.length) return console.log('no interfaces');
      for (const i of interfaces) console.log(`${i.path} -> ${i.teams.join(',')}`);
      return;
    }
    if (!['add', 'rm'].includes(sub)) throw new Error('usage: bus iface add <path> --teams a,b | rm <path> | list');
    const teams = csv(takeFlag(rest, '--teams', true));
    await request('POST', '/api/iface', { body: { path: p, teams, rm: sub === 'rm' } });
    console.log(sub === 'rm' ? `interface ${p} removed` : `interface ${p} -> ${teams.join(',')}`);
  },

  async approve([id]) {
    const { task: t } = await request('POST', '/api/approve', { body: { id } });
    console.log(`approved #${t.id} — its lead will merge it`);
  },

  async reject([id, ...why]) {
    const { task: t } = await request('POST', '/api/reject', { body: { id, why: why.join(' ') } });
    console.log(`rejected #${t.id} — sent back to ${t.owner}`);
  },

  async init(args) {
    const { init } = await import('../src/init.js');
    for (const line of init(args[0] || process.cwd())) console.log(line);
  },

  async hook([sub]) {
    const hooks = await import('../src/hooks.js');
    const fn = { pre: hooks.preEdit, post: hooks.postTool, bash: hooks.preBash, commit: () => hooks.preCommit() }[sub];
    if (!fn) throw new Error(`unknown hook "${sub}"`);
    process.exit(await fn());
  },

  async spawn(ids) {
    if (!ids.length) throw new Error('usage: bus spawn <task-id...>');
    for (const id of ids) {
      const { worker: w, running, max } = await request('POST', '/api/spawn', { body: { id } });
      console.log(`${w.name} ${w.status === 'running' ? 'started' : w.status} for #${w.task} (${running}/${max} running)`);
    }
  },

  async workers([sub, name]) {
    if (sub === 'stop') {
      const { worker: w } = await request('POST', '/api/spawn/stop', { body: { name } });
      return console.log(`${w.name}: ${w.note || w.status}`);
    }
    const { workers, running, max } = await request('GET', '/api/workers');
    console.log(`${running}/${max} running`);
    for (const w of workers) console.log(`${w.name} ${w.status} #${w.task}${w.note ? ' — ' + w.note : ''}`);
  },

  async report([id]) {
    if (!id) throw new Error('usage: bus report <id>');
    console.log((await request('GET', '/api/task/report', { query: { id } })).report);
  },

  async dashboard(args) {
    if (process.env.BUS_AGENT) throw new Error('bus dashboard is for the human — run it without BUS_AGENT');
    const noOpen = takeFlag(args, '--no-open');
    const base = new URL(baseUrl());
    const port = base.port || '80';
    const token = readHumanToken(port);
    if (!token) throw new Error(`no human token for port ${port} — start the server with bus serve (it writes ${humanTokenFile(port)})`);
    await request('GET', '/api/who'); // server up? token current? (401 under BUS_AUTH if it's from an older bus serve)
    const url = `${base.origin}/#t=${token}`;
    console.log(url);
    if (noOpen) return;
    const [cmd, cmdArgs] = openCommand(url);
    try {
      const p = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => console.error('bus: could not open a browser — open the link above'));
      p.unref();
    } catch { console.error('bus: could not open a browser — open the link above'); }
  },

  async auth([sub, agent]) {
    if (sub !== 'reset' || !agent) throw new Error('usage: bus auth reset <agent>');
    const r = await request('POST', '/api/auth/reset', { body: { agent } });
    console.log(r.reset ? `token for ${r.agent} reset — it can bus join again` : `${r.agent} had no token`);
  },

  help() { console.log(HELP); },
};

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function taskLine(t) {
  const who = (t.owner || (t.assignee ? '→' + t.assignee : '-')) + (t.team && t.team !== t.assignee ? ' [' + t.team + ']' : '');
  const deps = t.after.length ? ` [after ${t.after.map((d) => '#' + d).join(',')}]` : '';
  return `#${t.id} ${t.status} ${who}: ${t.title}${deps}`;
}

function taskDetail(t) {
  return [
    taskLine(t),
    `files: ${t.files.join(' ') || '-'}`,
    `check: ${t.check}`,
    t.commit && `commit: ${t.commit.slice(0, 7)} on ${t.branch ?? '?'}`,
    t.brief && `\n${t.brief}`,
  ].filter(Boolean).join('\n');
}

const taskCommands = {
  async add(args) {
    const body = {
      files: csv(takeFlag(args, '--files', true)),
      check: takeFlag(args, '--check', true),
      after: csv(takeFlag(args, '--after', true)),
      assignee: takeFlag(args, '--for', true),
      team: takeFlag(args, '--team', true),
      brief: takeFlag(args, '--brief', true) || '',
      timeout: takeFlag(args, '--timeout', true),
    };
    const briefFile = takeFlag(args, '--brief-file', true);
    if (briefFile) body.brief = (await import('node:fs')).readFileSync(briefFile, 'utf8');
    body.title = args.join(' ');
    const { task: t } = await request('POST', '/api/task/add', { body });
    console.log(`added ${taskLine(t)}`);
  },

  async list(args) {
    const mine = takeFlag(args, '--mine');
    const { tasks } = await request('GET', '/api/task/list', { query: { mine: mine ? 1 : '' } });
    if (!tasks.length) return console.log(mine ? 'no tasks for you' : 'no tasks');
    for (const t of tasks) console.log(taskLine(t));
  },

  async show([id]) { console.log(taskDetail((await request('GET', '/api/task/show', { query: { id } })).task)); },

  async take([id]) {
    const { task: t } = await request('POST', '/api/task/take', { body: { id } });
    console.log(`took ${taskDetail(t)}`);
  },

  async done(args) {
    const allowDirty = takeFlag(args, '--allow-dirty');
    const report = takeFlag(args, '--report', true) || '';
    const [id, ...summary] = args;
    const r = await request('POST', '/api/task/done', { body: { id, summary: summary.join(' '), allowDirty, report }, headers: { 'x-bus-cwd': gitRoot() } });
    if (r.ok) return console.log(`check passed — #${r.mr.task} sent to ${r.reviewer ?? 'its lead'} for review`);
    console.log(`check failed (exit ${r.code}) — fix and rerun bus task done ${id}\n${r.output}`);
    process.exitCode = 1;
  },

  async merged(args) {
    const force = takeFlag(args, '--force');
    const { task: t } = await request('POST', '/api/task/merged', { body: { id: args[0], force } });
    console.log(`#${t.id} merged — claims released, dependents notified`);
  },

  async reassign([id, to]) {
    const { task: t } = await request('POST', '/api/task/reassign', { body: { id, to } });
    console.log(`#${t.id} reassigned to ${t.assignee}`);
  },

  async drop([id]) {
    const { task: t } = await request('POST', '/api/task/drop', { body: { id } });
    console.log(`#${t.id} dropped`);
  },
};

async function main([cmd = 'help', ...args]) {
  const fn = commands[cmd] || (['-h', '--help'].includes(cmd) ? commands.help : null);
  if (!fn) { console.error(`bus: unknown command "${cmd}" — bus help`); process.exit(2); }
  try { await fn(args); }
  catch (e) { console.error(`bus: ${e.message}`); process.exit(1); }
}

main(process.argv.slice(2));
