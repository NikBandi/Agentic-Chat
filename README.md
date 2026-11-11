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
- The edit-guard hook (exit code 2) blocks Claude Code's Edit/Write/MultiEdit/NotebookEdit on files claimed by another agent. When `BUS_AGENT` is unset it allows the edit silently.
- **Git pre-commit guard:** `bus init` also installs `pre-commit` in the repo's hooks dir. That's the common dir shared by all worktrees, and `core.hooksPath` is honoured. The guard checks every staged file with the bus and blocks the commit with one line (`bus: commit blocked — <file> is claimed by <agent>; …`) when a file is claimed by another agent, or is a hot file and the committer isn't the lead. This catches edits made through shell commands, which the edit guard can't see. It allows the commit when `BUS_AGENT` is unset (the human), when the bus is down, and when **the lead** concludes a merge (`MERGE_HEAD` exists): approved work stays claimed until `bus task merged`. A worker's merge commit is checked like any other, so claimed files can't be slipped in through a merge. An existing pre-commit hook is never overwritten: it's renamed to `pre-commit.pre-bus` and runs first.
- **Bus down:** if a hook can't reach the bus while `BUS_AGENT` is set, it allows the edit or commit and prints one line once: `bus: server unreachable — edits are NOT being guarded`. The Claude Code hooks put that line in the agent's context and show it to you. A marker file in the temp dir, keyed on agent and port, keeps it to once, and the marker is cleared as soon as the bus answers again.

## Tasks

```sh
# lead
bus task add "Users API" --files src/api/ --check "npm test -- users" --for backend --brief-file brief.md
bus task add "Users page" --files src/ui/ --check "npm test -- ui" --after 1 --for frontend
# worker (offered by DM when ready; the check runs in the worker's worktree)
bus task take 1
git commit -am "list endpoint"          # done refuses uncommitted work
bus task done 1 "list endpoint"         # failure -> last 25 lines of output; pass -> merge request to @lead
# human: dashboard, `bus approve 1` / `bus reject 1 "why"`, or chat "@lead approve #1"
# lead, after merging the branch:
bus task merged 1                       # verifies the commit is in main, releases claims, tells #2's assignee to rebase and start
```

Task states are `open → in_progress → review → approved → merged`, plus `dropped`. A rejection sends the task back to `in_progress`.

- `bus task done` runs `git status --porcelain` in the worker's worktree first. If anything is uncommitted it refuses with `bus: commit your changes first (N files uncommitted)`, and the check doesn't run. The bus's own `.bus/` folder doesn't count. `--allow-dirty` skips this, and a worktree that isn't a git repo isn't checked at all.
- When the check passes, the worktree's HEAD commit is stored on the merge request next to the branch. `bus task show` prints it as `commit: <sha> on <branch>`, and the dashboard shows it too.
- `bus task merged` runs `git merge-base --is-ancestor <commit> <main>` in the lead's worktree (or in the repo `bus serve` started in). If the commit isn't in main it refuses with `bus: <sha> is not in <main> yet — merge it first with plain git merge <sha> (no squash or rebase)`. The approval notice to the lead names that same commit (`merge <sha7>`), not the branch, so commits pushed to the branch after approval can't slip in unreviewed. Squashing or rebasing creates new commits, so the reviewed one is never found in main and the check refuses. The main branch is `BUS_MAIN` if set, otherwise `main`, or `master` if `main` doesn't exist. `--force` lets the lead skip the check, and the activity log records that it did.

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

## Agent tokens (optional, `BUS_AUTH=1`)

This is off by default, so existing setups keep working. Start the server with `BUS_AUTH=1 bus serve` to turn it on:

- On an agent's first `bus join`, the server issues a random token. The CLI saves it in `<worktree>/.bus/agents/<name>.token`, and `.bus/` gets its own `.gitignore` so the token is never committed. The server keeps only a SHA-256 of the token and never serves it, not even through `/api/state`.
- Every later request from that agent must send the token. The CLI and the hooks find it by looking upward from the current directory. Without a valid token the request fails with 401, the edit guard and pre-commit guard block, and a token-less `bus join` can't take over the name.
- Lost a token? The human runs `bus auth reset <agent>`, and the agent joins again.

## Human lock

- **Human token:** every `bus serve` creates a fresh human token and saves it to `~/.agentic-chat/<port>.human.token`, outside every repo. It also prints the dashboard link with the token in it: `dashboard: http://127.0.0.1:4477/#t=…`. Open that link once. The dashboard moves the token into `sessionStorage` (this tab only), removes it from the address bar, and sends it on every request. Human CLI commands (run without `BUS_AGENT`) read the token file automatically. The file is deleted on a clean shutdown.
- **`bus dashboard [--no-open]`** (human only) prints the current tokened link and opens it in your default browser. Use it after a restart or in a new terminal. It refuses to run in agent sessions, and the shell guard blocks it there too, because its output contains the human token. It errors out instead of printing a stale link if the server isn't running or (with `BUS_AUTH=1`) the token file comes from an older `bus serve`.
- **With `BUS_AUTH=1`,** any request with no agent name (or the name `you`) needs the human token, or it gets 401. That covers everything only the human can do (approve, reject, `auth reset`, releasing another agent's claims) and the dashboard's own reads. Without `BUS_AUTH` nothing changes.
- **Shell guard:** `bus init` adds a PreToolUse hook on `Bash|PowerShell`. For agent sessions (`BUS_AGENT` set), it blocks commands that run `bus approve|reject|auth`, call those API endpoints, unset or override `BUS_AGENT` (`unset`, `BUS_AGENT=…`, `export`, `env -u`/`-i`, `$env:BUS_AGENT`, `set`), or touch `~/.agentic-chat`. Each block is one line: `bus: blocked — this command … Agents can't act as the human; ask @you.` It errs toward blocking, so a commit message that contains `bus approve` is refused too.
- **Deny rules:** `bus init` also adds `Read(~/.agentic-chat/**)` and `Edit(~/.agentic-chat/**)` to `permissions.deny` in `.claude/settings.json`.
- **Merge commits:** the pre-commit guard exempts only the lead concluding a merge.

**What this does and doesn't protect against:** these are guard rails against mistakes and casual misuse. They stop an agent that follows instructions badly, guesses at a shortcut, or tries the obvious workaround. They are **not** a security boundary against a malicious process running as your user:
- Such a process can read `~/.agentic-chat` with tools the hooks don't see.
- It can write a script that calls the API.
- It can edit `.claude/settings.json` or `.git/hooks`.
- It can talk to the server directly; the server binds to 127.0.0.1, which keeps out other machines but not other programs on yours.

Pattern-matching shell commands can always be evaded with enough effort. For real isolation, run agents as a separate OS user or in a container that can't read your home directory.

## Orca

Orca already creates worktrees (`orca worktree create`) and launches agents, so the bus doesn't do either. It records each agent's worktree root on `bus join` so that later done-checks run there.

## Development

```sh
npm test
```
