// Runs a task's done-check in a worker's worktree and returns only the tail of its output.
import { spawn, execFile } from 'node:child_process';

export const OUT_LINES = 25;
export const OUT_CHARS = 2500;
const KEEP_BYTES = 64 * 1024;

/** Last OUT_LINES lines / OUT_CHARS chars, ANSI stripped — failure output agents actually need. */
export function tail(text) {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n').trimEnd();
  const lines = clean.split('\n');
  let out = lines.slice(-OUT_LINES).join('\n');
  if (out.length > OUT_CHARS) out = out.slice(-OUT_CHARS);
  const cut = clean.length - out.length;
  return (cut > 0 ? `…(${lines.length > OUT_LINES ? lines.length - OUT_LINES + ' lines' : cut + ' chars'} cut)\n` : '') + out;
}

function killTree(p) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {});
  else { try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }
}

/** Resolves {ok, code, output, ms, timedOut}. Never rejects. */
export function runCheck(cmd, cwd, timeoutS = 600) {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env, CI: '1' };
    delete env.BUS_AGENT; delete env.BUS_TEAM; // the check is not an agent
    let buf = '';
    let timedOut = false;
    let p;
    try {
      p = spawn(cmd, { cwd, shell: true, env, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      return resolve({ ok: false, code: null, output: `could not start check: ${e.message}`, ms: 0, timedOut });
    }
    const add = (d) => { buf += d; if (buf.length > KEEP_BYTES) buf = buf.slice(-KEEP_BYTES); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(p); }, timeoutS * 1000);
    p.on('error', (e) => add(`\n${e.message}`));
    p.on('close', (code) => {
      clearTimeout(timer);
      const output = tail(buf) + (timedOut ? `\n(timed out after ${timeoutS}s)` : '');
      resolve({ ok: code === 0 && !timedOut, code, output, ms: Date.now() - start, timedOut });
    });
  });
}

/** Current branch of a worktree, or null. */
export function currentBranch(cwd) {
  return new Promise((ok) => execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, windowsHide: true },
    (err, out) => ok(err ? null : out.trim())));
}

/** Run git in cwd. Resolves {code, out, err} (out untrimmed); code -1 if git couldn't start. Never rejects. */
export function git(args, cwd) {
  return new Promise((ok) => execFile('git', args, { cwd, windowsHide: true }, (e, out, err) =>
    ok({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(out ?? ''), err: String(err ?? '').trim() })));
}

/** Number of changed/untracked files in a worktree (the bus's own .bus/ excluded), or null if not a git repo. */
export async function uncommitted(cwd) {
  const r = await git(['status', '--porcelain'], cwd);
  if (r.code !== 0) return null;
  return r.out.split('\n').filter((l) => l.trim() && !/^.. "?\.bus\//.test(l)).length;
}

/** HEAD commit SHA of a worktree, or null. */
export async function headSha(cwd) {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  return r.code === 0 ? r.out.trim() : null;
}

/** BUS_MAIN, else "main", else "master" if only master exists. */
export async function mainBranch(cwd) {
  if (process.env.BUS_MAIN) return process.env.BUS_MAIN;
  for (const b of ['main', 'master']) if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], cwd)).code === 0) return b;
  return 'main';
}

/** Is commit `sha` contained in `ref`? Resolves {in: boolean} or {err: first line of git's error}. */
export async function isAncestor(sha, ref, cwd) {
  const r = await git(['merge-base', '--is-ancestor', sha, ref], cwd);
  if (r.code === 0) return { in: true };
  if (r.code === 1) return { in: false };
  return { err: r.err.split('\n')[0] || `git exited ${r.code}` };
}
