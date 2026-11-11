// `bus init [project]`: merge bus hooks into .claude/settings.json and add agent rules to CLAUDE.md.
// Idempotent; never clobbers other settings or CLAUDE.md content outside the markers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUS_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.js');
const START = '<!-- agent-bus -->';
const END = '<!-- /agent-bus -->';

export const AGENT_RULES = `${START}
## Agent bus (applies only when BUS_AGENT is set)
- You are $BUS_AGENT on team $BUS_TEAM. Coordinate only via the \`bus\` CLI (\`bus help\`).
- Start: \`bus join\`, \`bus task list --mine\`, \`bus task take <id>\`. The task brief is your full context.
- Edit only files your task claims. If an edit is blocked, ask the owner (\`bus send @owner "..."\`); never work around it with shell writes.
- Hot files (package.json, lockfiles, shared types, global config): \`bus request <file> "change"\` instead of editing.
- When a hook notice says something is waiting, run \`bus read\`. Never poll. Blocked on someone? \`bus wait\`.
- Commit your work on your branch before bus task done.
- Done: \`bus task done <id> "summary"\` runs the done-check; fix failures and retry.
- Keep messages short; @mention only who must act. Full text of a truncated message: \`bus show <id>\`.
${END}`;

const hookCmd = (sub) => `node "${BUS_BIN.replace(/\\/g, '/')}" hook ${sub}`;

export const HOOKS = {
  PreToolUse: { matcher: 'Edit|Write|MultiEdit|NotebookEdit', sub: 'pre' },
  PostToolUse: { matcher: '*', sub: 'post' },
};

/** Add (or update) our hook entries in a settings object. Returns true if it changed. */
export function mergeSettings(settings) {
  let changed = false;
  settings.hooks ??= {};
  for (const [event, { matcher, sub }] of Object.entries(HOOKS)) {
    const list = (settings.hooks[event] ??= []);
    const cmd = hookCmd(sub);
    const isOurs = (h) => typeof h.command === 'string' && /bus\.js"? hook /.test(h.command) && h.command.endsWith(` hook ${sub}`);
    const existing = list.find((g) => g.hooks?.some(isOurs));
    if (existing) {
      const h = existing.hooks.find(isOurs);
      if (h.command !== cmd || existing.matcher !== matcher) { h.command = cmd; existing.matcher = matcher; changed = true; }
    } else {
      list.push({ matcher, hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
      changed = true;
    }
  }
  return changed;
}

/** Insert or replace the marked agent-rules block. */
export function mergeClaudeMd(text) {
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s !== -1 && e > s) return text.slice(0, s) + AGENT_RULES + text.slice(e + END.length);
  return (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + AGENT_RULES + '\n';
}

export function init(projectDir = process.cwd()) {
  const dir = path.resolve(projectDir);
  const out = [];
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    try { settings = raw.trim() ? JSON.parse(raw) : {}; }
    catch { throw new Error(`${settingsFile} is not valid JSON — fix it and re-run`); }
  }
  if (mergeSettings(settings)) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    out.push(`updated ${settingsFile}`);
  } else out.push(`hooks already present in ${settingsFile}`);

  const mdFile = path.join(dir, 'CLAUDE.md');
  const before = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  const after = mergeClaudeMd(before);
  if (after !== before) { fs.writeFileSync(mdFile, after); out.push(`updated ${mdFile}`); }
  else out.push(`agent rules already current in ${mdFile}`);
  return out;
}
