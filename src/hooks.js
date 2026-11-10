// Claude Code hook handlers. Both are no-ops (exit 0, no output) unless BUS_AGENT is set and the bus is up,
// so they never get in the way and cost zero tokens when there is nothing to say.
import fs from 'node:fs';
import path from 'node:path';
import { request } from './client.js';
import { toRepoPath } from './paths.js';

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
  try { r = await request('GET', '/api/check', { query: { path: rel }, timeoutMs: 1500 }); }
  catch { return 0; } // bus down / unknown agent: allow silently
  if (r.free) return 0;
  process.stderr.write(`bus: ${rel} is claimed by ${r.owner} (${r.claim}). Do not edit it or work around this block. Ask the owner: bus send @${r.owner} "<what you need>"\n`);
  return 2;
}
