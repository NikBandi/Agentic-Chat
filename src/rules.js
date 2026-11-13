// The agent rules, injected by the SessionStart hook only into sessions that have BUS_AGENT set (and again after a
// compaction), so the human's own sessions and other projects pay nothing. Workers get the worker lines; leads and
// the head get one more. Spawned workers skip them: their prompt (spawn.js) already carries what they need.

const WORKER = [
  '- Start: `bus join`, `bus task list --mine`, `bus task take <id>`. The brief, the files it says to read first and the notes it prints are your full context.',
  '- Edit only files your task claims. If an edit is blocked, ask the owner (`bus send @owner "..."`); never work around it with shell writes.',
  '- Hot files (package.json, lockfiles, shared types, global config) belong to the head: `bus request <file> "change"` instead of editing.',
  '- Hook notices show short messages inline; otherwise run `bus read`. Never poll. Blocked on someone? Run `bus wait 3600` in the background (run_in_background) and end your turn; you are woken when something arrives.',
  '- Commit your work on your branch before bus task done. On bus task done, include --report with up to 3 lines; it runs the done-check — fix failures and retry.',
  '- Learned a module others will need? Leave a note of at most 5 lines: `bus note add <path> "..."`. It is shown to whoever takes a task touching that path.',
  '- Keep messages short; DM the one agent who must act (@team reaches, and costs, every member). Full text of a message: `bus show <id>`.',
];

const LEAD = '- Leads: plan and review only your own team\'s tasks; give each task `--context a,b` (files to read first) so workers don\'t explore. Start workers with `bus spawn <ids>` (max 4 run at once — spawn only tasks that can run in parallel); contract and hot-file questions go to @head. Merge with plain `git merge <sha>` — no squash or rebase.';

/** The rules for this session's identity (from env), or '' when it isn't an agent. */
export function rulesFor(env = process.env) {
  const name = String(env.BUS_AGENT ?? '').trim();
  if (!name) return '';
  const role = ['lead', 'head'].includes(String(env.BUS_ROLE ?? '').trim().toLowerCase()) || name.toLowerCase() === 'lead'
    ? (String(env.BUS_ROLE ?? '').trim().toLowerCase() || 'head') : 'worker';
  const team = String(env.BUS_TEAM ?? '').trim() || '-';
  return [
    `Agent bus: you are ${name} on team ${team}${role === 'worker' ? '' : ` (${role})`}. Coordinate only via the \`bus\` CLI (\`bus help\`).`,
    ...WORKER,
    ...(role === 'worker' ? [] : [LEAD]),
  ].join('\n');
}
