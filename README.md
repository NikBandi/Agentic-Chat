# Agentic Chat

A local chat, file-claim and task bus that lets many Claude Code agents work on one codebase without overwriting each other. The spec is in [DESIGN.md](DESIGN.md).

Node 18+, zero dependencies. The server listens only on `127.0.0.1`.

## Status

| Build step (DESIGN.md §8) | State |
|---|---|
| 1. Server core: agents/teams, mention-only inbox, claims, persistence | done |
| 2. `bus` CLI for the above | done |
| 3. PreToolUse edit-guard hook + `bus init` | done |
| 4. Tasks, done-checks, merge requests, approvals, auto-handoff | todo |
| 5. PostToolUse notification hook | todo |
| 6. Dashboard | todo |
| 7. Hot files, interface alerts, inactivity | todo |

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

## Orca

Orca already creates worktrees (`orca worktree create`) and launches agents, so the bus doesn't do either. It records each agent's worktree root on `bus join` so that later done-checks run there.

## Development

```sh
npm test
```
