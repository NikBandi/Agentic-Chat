// Git worktrees the bus creates (for `bus spawn` and `bus worktree`). Plain git, no IDE needed.
// All of them live under one folder next to the repo — <repo>.worktrees/<name> — or under BUS_WORKTREE_DIR.
// Kept outside the repo so test runners and file watchers never scan them.
import fs from 'node:fs';
import path from 'node:path';
import { git, mainBranch, uncommitted } from './check.js';

/** The folder that holds every bus worktree for `repo`. */
export function worktreeRoot(repo, env = process.env) {
  return env.BUS_WORKTREE_DIR ? path.resolve(repo, env.BUS_WORKTREE_DIR) : path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`);
}

/**
 * Create (or reuse) the worktree for `name` on branch `name`, starting from the main branch.
 * An existing folder is reused as-is (a respawn keeps its branch and commits); an existing branch is checked out.
 */
export async function addWorktree(repo, name, env = process.env) {
  const wt = path.join(worktreeRoot(repo, env), name);
  if (fs.existsSync(wt)) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const main = await mainBranch(repo);
  const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo)).code === 0;
  const r = await git(exists ? ['worktree', 'add', wt, name] : ['worktree', 'add', '-b', name, wt, main], repo);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err.split('\n')[0]}`);
  return wt;
}

/**
 * Remove a worktree the bus created, never losing work: refused if anything is uncommitted (the bus's own .bus/
 * aside). Committed work stays on the branch, which is deleted only when merged (`git branch -d` refuses otherwise).
 * Resolves { removed, reason?, branchDeleted, branchNote? }.
 */
export async function removeWorktree(repo, wt, branch) {
  if (!fs.existsSync(wt)) return { removed: false, reason: 'already gone' };
  const dirty = await uncommitted(wt);
  if (dirty) return { removed: false, reason: `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` };
  const rm = await git(['worktree', 'remove', '--force', wt], repo); // --force: only .bus/ can be left (checked above)
  if (rm.code !== 0) return { removed: false, reason: rm.err.split('\n')[0] || `git exited ${rm.code}` };
  // The default <repo>.worktrees folder goes too once it's empty (never a BUS_WORKTREE_DIR you chose).
  if (path.dirname(wt).endsWith('.worktrees')) try { fs.rmdirSync(path.dirname(wt)); } catch { /* still holds others */ }
  const br = await git(['branch', '-d', branch], repo);
  return { removed: true, branchDeleted: br.code === 0, ...(br.code !== 0 && { branchNote: br.err.split('\n')[0] }) };
}
