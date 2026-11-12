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

### Team leads (`BUS_ROLE`)

For more than one team, give each team its own lead and add one small **head**:

```sh
BUS_ROLE=head BUS_AGENT=head claude                          # one per bus
BUS_ROLE=lead BUS_AGENT=fe-lead BUS_TEAM=frontend claude     # one per team
BUS_ROLE=lead BUS_AGENT=be-lead BUS_TEAM=backend claude
BUS_AGENT=fe-1 BUS_TEAM=frontend claude                      # workers: no BUS_ROLE
```

- **Head:** owns hot files, interfaces and `bus request`s; can manage any team's tasks; reviews and merges tasks that a lead owns itself (e.g. the head's "Build the frontend" task taken by fe-lead). Inactive leads are reported to it.
- **Team lead:** adds tasks only for its own team (they default to `--for <team>`), and is the one told when its team's tasks pass, are approved or rejected, or when a teammate goes inactive. It merges and runs `bus task merged`, `reassign`, `drop` and `bus report` only for its team, and never signs off its own task. Hot files are blocked for it like for a worker.
- **Tasks carry a team** (`--team t`, or derived from `--for`), and only that team's members can take them. Leads and the head are never offered tasks automatically, only ones that name them.
- Roles are fixed at join. There can be only one head, and one lead per team. The shell guard blocks changing `BUS_ROLE`. The pre-commit merge exemption covers any `BUS_ROLE=lead|head` session.
- Without `BUS_ROLE`, an agent named `lead` is the head, so single-lead setups work unchanged.

### Lead-spawned workers (`bus spawn`)

A lead doesn't need you to open worker sessions. It decides how many tasks can run in parallel and starts one worker per task:

```sh
bus spawn 3 4 5      # lead (own team's tasks), head, or human
bus workers          # 3/4 running, plus each worker's status
bus workers stop frontend-2
```

- **Each worker gets its own git worktree** next to the repo (`<repo>-frontend-1`, branch `frontend-1`) and a headless `claude -p` session. Its prompt holds only the task: join, take the task (the brief is its full context), test first, commit, `bus task done --report`. Hooks come from `--settings .bus/worker-settings.json`, so the worktree stays clean, and `ECC_HOOK_PROFILE=minimal` is set.
- **Token limits:** at most `BUS_MAX_WORKERS` (default **4**, max 16) run at once across the whole bus. Extra spawns queue and start as slots free up, and a task waiting on dependencies doesn't take a slot. A worker **exits as soon as its check passes**, so no session sits idle. Optional: `BUS_WORKER_MODEL` (e.g. `sonnet`) and `BUS_WORKER_BUDGET` (USD per run, `--max-budget-usd`).
- **Rejected?** The same worker is re-spawned in the same worktree, with the reason in its prompt. If a worker exits without handing its task in, its lead gets one notice with the log path (`.bus/workers/<name>.log`).
- Spawned workers are never offered other tasks and are not flagged inactive after exiting. Merging and approval work exactly as before.
- **Permissions:** workers run with `--permission-mode bypassPermissions` (they're unattended), still behind the bus edit guard, shell guard and pre-commit guard. Set `BUS_WORKER_PERMISSION=acceptEdits` for a stricter mode (shell commands may then be refused). Starting the command: `BUS_CLAUDE` (default `claude`).

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
- **Reports:** `bus task done <id> --report "built X\nproblems: Y\nunfinished: Z"` takes up to 3 short lines (≤160 chars each), separated by real newlines or a literal `\n`. More is refused before the check runs. When the check passes, the bus writes the rest of the report from its own records, at no token cost to agents:
  - agent, role and team
  - time spent since `take`
  - files claimed
  - the commit
  - check runs, failures and the final result
  - messages sent and received during the task, grouped by counterpart (`↔ backend-1: 4 sent, 3 received; → lead: 2; ← you: 1`; system notices aren't counted)

  The report is stored on the task, appended to `.bus/reports.md` next to the state file, and shown on the dashboard's merge-request card. The lead or human prints it with `bus report <id>`. Reports never go to agent inboxes; the lead's "passed its check" notice only says `review (bus report <id>)`.
- When the check passes, the worktree's HEAD commit is stored on the merge request next to the branch. `bus task show` prints it as `commit: <sha> on <branch>`, and the dashboard shows it too.
- `bus task merged` runs `git merge-base --is-ancestor <commit> <main>` in the lead's worktree (or in the repo `bus serve` started in). If the commit isn't in main it refuses with `bus: <sha> is not in <main> yet — merge it first with plain git merge <sha> (no squash or rebase)`. The approval notice to the lead names that same commit (`merge <sha7>`), not the branch, so commits pushed to the branch after approval can't slip in unreviewed. Squashing or rebasing creates new commits, so the reviewed one is never found in main and the check refuses. The main branch is `BUS_MAIN` if set, otherwise `main`, or `master` if `main` doesn't exist. `--force` lets the lead skip the check, and the activity log records that it did.

- A task can't be taken until everything it depends on is merged. Each agent works one task at a time, and taking a task claims its files.
- A task assigned to a team is offered to the earliest-joined free member of that team. Offers go out as DMs when the task is added, when an agent joins, and when a task is merged, reassigned or dropped.
- Only the human can approve a merge. The lead reports the merge with `bus task merged`. The bus never runs git merges itself.

## Dashboard

Run `bus dashboard` (or open the link `bus serve` prints). It's one self-contained page with no dependencies, built to be calm enough to leave open all day. Color only means something. Persimmon appears only when you need to act; otherwise the page is nearly colorless. Status is always shown as a label as well as a color.

- **Top bar:** a connection dot, a theme toggle (auto / light / dark, remembered), and a "N need you" pill when something is waiting. The tab title shows `(N) Agentic Chat`.
- **Needs you:** merge requests show the agent, branch, short SHA, check result (output behind a click), summary and report. Approve, or Reject with an inline reason field. Unread messages to you appear here too. When nothing is waiting: "Nothing needs you. Breathe."
- **Tasks:** columns Open → In progress → Review → Approved → Merged, with merged and dropped tasks collapsed. Dependency chips stay dimmed until merged. Click a card for its brief, files, done-check, last output, report, Reassign, and Drop (with an inline confirm).
- **Agents:** tabs Active · Waiting · Idle · Done · Inactive, remembered. Waiting means blocked in `bus wait` right now; Idle means no task in progress and not in `bus wait`.
  - Each card shows role, team, task, a 5-step progress line (taken → checking → review → approved → merged), time on task, last seen, last check, and last message.
  - Done shows each agent's report.
  - Inactive dims the card and hides Reassign and Release claims behind a click.
  - Click a card for the agent's full history: tasks, reports, commits, check runs, and who it talked with.
- **Messages:** channels and DMs with unread counts (system notices don't count). Mentions of you get a persimmon edge. The composer has `@`/`#` autocomplete, and Enter sends.
- **Claims** are grouped by agent, with hot files, interfaces and requests below. The activity log sits in a collapsed **Quiet log**.
- **Responsive** to one column below 1000px. Keyboard throughout: Esc closes panels, arrow keys switch tabs, and focus is visible. Respects reduced motion. Text contrast is WCAG AA in both themes.

`/api/state` marks each agent that is blocked in `bus wait` with `waiting: true`. The flag is live (it comes from the server's open long-polls), is never written to disk, and the dashboard gets a change event when an agent enters or leaves `bus wait`.

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
- **Merge commits:** the pre-commit guard exempts only a lead or the head (`BUS_ROLE`) concluding a merge.

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
