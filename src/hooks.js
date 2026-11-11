// Claude Code hook handlers + the git pre-commit guard. All are no-ops (exit 0, no output) unless BUS_AGENT is set,
// so they never get in the way and cost zero tokens when there is nothing to say.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request, baseUrl, NotRunning } from './client.js';
import { toRepoPath } from './paths.js';
import { git } from './check.js';

export const DOWN_MSG = 'bus: server unreachable — edits are NOT being guarded';

const readStdin = () => new Promise((ok) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (s += c));
  process.stdin.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
  process.stdin.on('error', () => ok({}));
});

/** Nearest ancestor containing .git (dir in a normal checkout, file in a git worktree). */
export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---- "bus is down" warning: once per agent+port until the bus is reachable again ----------------

export function markerPath() {
  const port = new URL(baseUrl()).port || '80';
  const who = String(process.env.BUS_AGENT).replace(/[^\w-]/g, '_');
  return path.join(os.tmpdir(), `agent-bus-down-${who}-${port}`);
}
/** Returns DOWN_MSG the first time the bus is found unreachable, then null until it is reachable again. */
export function downNotice() {
  const p = markerPath();
  if (fs.existsSync(p)) return null;
  try { fs.writeFileSync(p, String(Date.now())); } catch { /* can't persist: still warn */ }
  return DOWN_MSG;
}
function reachable() {
  const p = markerPath();
  if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* ignore */ }
}
/** Hook JSON that puts one line in Claude's context and shows it to the human. */
const say = (event, line) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line }, systemMessage: line }));

/**
 * PostToolUse on every tool: if something new is waiting, add one line to the agent's context via
 * hookSpecificOutput.additionalContext (plain stdout isn't shown to Claude for PostToolUse).
 * Nothing waiting -> no output at all, so zero tokens.
 */
export async function postTool() {
  if (!process.env.BUS_AGENT) return 0;
  process.stdin.resume(); // drain the hook input; we don't need it
  process.stdin.on('data', () => {});
  let r;
  try { r = await request('GET', '/api/notice', { timeoutMs: 800 }); }
  catch (e) {
    const msg = e instanceof NotRunning && downNotice();
    if (msg) say('PostToolUse', msg);
    return 0;
  }
  reachable();
  if (r.notice) say('PostToolUse', r.notice);
  return 0;
}

/** PreToolUse on Edit|Write|MultiEdit|NotebookEdit: block edits to files claimed by another agent. */
export async function preEdit() {
  if (!process.env.BUS_AGENT) return 0;
  const input = await readStdin();
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file) return 0;
  const abs = path.resolve(input.cwd || process.cwd(), file);
  const root = findRoot(path.dirname(abs)) || findRoot(input.cwd || process.cwd());
  const rel = root && toRepoPath(abs, root);
  if (!rel) return 0;
  let r;
  try { r = await request('GET', '/api/check', { query: { path: rel, edit: 1 }, timeoutMs: 1500 }); }
  catch (e) {
    if (e.status === 401) { process.stderr.write(`bus: ${e.message}\n`); return 2; } // BUS_AUTH: identity not proven
    const msg = e instanceof NotRunning && downNotice(); // bus down / other errors: allow
    if (msg) say('PreToolUse', msg);
    return 0;
  }
  reachable();
  if (r.free) return 0;
  process.stderr.write(r.hot
    ? `bus: ${rel} is a hot file owned by lead. Do not edit it or work around this block. Ask for the change: bus request ${rel} "<change>"\n`
    : `bus: ${rel} is claimed by ${r.owner} (${r.claim}). Do not edit it or work around this block. Ask the owner: bus send @${r.owner} "<what you need>"\n`);
  return 2;
}

/**
 * git pre-commit: block commits that stage files claimed by another agent (or hot files, unless lead).
 * Catches edits made through shell commands, which the PreToolUse guard can't see.
 * Allowed: no BUS_AGENT, bus down, nothing staged, or concluding a merge (the lead merging approved work).
 */
export async function preCommit(cwd = process.cwd()) {
  if (!process.env.BUS_AGENT) return 0;
  if ((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)).code === 0) return 0;
  const staged = await git(['diff', '--cached', '--name-only', '--no-renames', '-z'], cwd);
  if (staged.code !== 0) return 0;
  const files = staged.out.split('\0').filter(Boolean);
  if (!files.length) return 0;
  let results;
  try {
    results = await Promise.all(files.map(async (f) => [f, await request('GET', '/api/check', { query: { path: f }, timeoutMs: 1500 })]));
  } catch (e) {
    if (e.status === 401) { process.stderr.write(`bus: commit blocked — ${e.message}\n`); return 1; }
    const msg = e instanceof NotRunning && downNotice();
    if (msg) process.stderr.write(msg + '\n');
    return 0;
  }
  reachable();
  const blocked = results.filter(([, r]) => !r.free);
  if (!blocked.length) return 0;
  const [f, r] = blocked[0];
  const more = blocked.length > 1 ? ` (+${blocked.length - 1} more)` : '';
  process.stderr.write(r.hot
    ? `bus: commit blocked — ${f} is a hot file owned by lead${more}; unstage it and ask: bus request ${f} "<change>"\n`
    : `bus: commit blocked — ${f} is claimed by ${r.owner}${more}; unstage it (git restore --staged ${f}) and ask @${r.owner}\n`);
  return 1;
}
