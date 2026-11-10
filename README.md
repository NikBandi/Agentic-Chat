# Agentic Chat

A local chat, file-claim and task bus that lets many Claude Code agents work on one codebase without overwriting each other. The spec is in [DESIGN.md](DESIGN.md).

Node 18+, zero dependencies. The server listens only on `127.0.0.1`.

## Status

| Build step (DESIGN.md §8) | State |
|---|---|
| 1. Server core: agents/teams, mention-only inbox, claims, persistence | done |
| 2. `bus` CLI for the above | done |
| 3. PreToolUse edit-guard hook + `bus init` | done |
| 4. Tasks, done-checks, merge requests, approvals, auto-handoff | done |
| 5. PostToolUse notification hook | done |
| 6. Dashboard | done |
| 7. Hot files, interface alerts, inactivity | done |

## Quick start

```sh
npm link                       # puts `bus` on your PATH (or run: node bin/bus.js ...)
bus serve                      # in the main repo; state goes to .bus/state.json
bus init /path/to/project      # once: adds the edit-guard hook + agent rules to the project
```

Start each Claude Code session (for example in an Orca worktree terminal) with an identity:

```sh
BUS_AGENT=frontend-1 BUS_TEAM=frontend claude      # PowerShell: $env:BUS_AGENT='frontend-1'; $env:BUS_TEAM='frontend'; claude
```

The lead session uses `BUS_AGENT=lead`. Commands run without `BUS_AGENT` act as the human (`you`).

## How messages reach agents

- `bus send @bob ...` is a DM. `bus send @frontend ...` posts to `#frontend` and mentions the team. `bus send #general ...` is a plain channel post.
- An agent's inbox (`bus read` / `bus wait`) holds **only** DMs to it and messages that mention `@its-name` or `@its-team`. Plain channel chatter never shows up there; to see it, run `bus log #chan`.
- Output is one line per message, and long messages are truncated (`bus show <id>` gives the full text). A catch-up shows at most 30 messages.

## Claims

`bus claim src/api/ "src/**/*.css" README.md -m why`

- A claim succeeds completely or not at all. Overlap checks for globs are conservative.
- Paths are repo-relative with forward slashes, and case-insensitive on Windows.
- The edit-guard hook (exit code 2) blocks Claude Code's Edit/Write/MultiEdit/NotebookEdit on files claimed by another agent. When the bus is down or `BUS_AGENT` is unset, the hook allows the edit silently.

## Tasks

```sh
# lead
bus task add "Users API" --files src/api/ --check "npm test -- users" --for backend --brief-file brief.md
bus task add "Users page" --files src/ui/ --check "npm test -- ui" --after 1 --for frontend
# worker (offered by DM when ready; the check runs in the worker's worktree)
bus task take 1
bus task done 1 "list endpoint"         # failure -> last 25 lines of output; pass -> merge request to @lead
# human: dashboard, `bus approve 1` / `bus reject 1 "why"`, or chat "@lead approve #1"
# lead, after merging the branch:
bus task merged 1                       # releases claims, tells #2's assignee to rebase and start
```

Task states are `open → in_progress → review → approved → merged`, plus `dropped`. A rejection sends the task back to `in_progress`.

- A task can't be taken until everything it depends on is merged. Each agent works one task at a time, and taking a task claims its files.
- A task assigned to a team is offered to the earliest-joined free member of that team. Offers go out as DMs when the task is added, when an agent joins, and when a task is merged, reassigned or dropped.
- Only the human can approve a merge. The lead reports the merge with `bus task merged`. The bus never runs git merges itself.

## Dashboard

Open http://127.0.0.1:4477/ while `bus serve` is running. It shows merge requests with Approve and Reject buttons, the task board (reassign or drop), agents (inactive after 30 minutes), claims, hot files, interfaces and open requests, channels and DMs with a composer that posts as you, and the activity log. Updates arrive live over Server-Sent Events.

## Hot files, interfaces, inactivity

- `bus hot add package.json package-lock.json`: hot files count as claimed by the lead. Workers ask for changes with `bus request <file> "change"`, and the lead answers with `bus request done|decline <id> ["why"]`.
- `bus iface add src/types/ --teams frontend,backend`: when an agent edits an interface, it gets a one-time notice telling it to tell the teams that use it. `bus task done` refuses until it has @mentioned those teams.
- An agent silent for 30 minutes (`BUS_INACTIVE_MIN`) is marked inactive and the lead is told once. An agent blocked in `bus wait` doesn't count as silent. The lead can then `bus task reassign` or `bus release --of <agent> --all`.
- Hook notices (PostToolUse) are one line, shown once per new batch of messages, and print nothing at all when nothing is waiting.

## Orca

Orca already creates worktrees (`orca worktree create`) and launches agents, so the bus doesn't do either. It records each agent's worktree root on `bus join` so that later done-checks run there.

## Development

```sh
npm test
```
