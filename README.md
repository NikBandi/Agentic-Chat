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
bus init /path/to/project      # once: adds the bus hooks + pre-commit guard to the project
```

`bus init` writes nothing into the project's CLAUDE.md. The agent rules come from a **SessionStart hook**, and only sessions with `BUS_AGENT` set get them; leads get one extra line. Your own sessions, and any session without an identity, load none of them. The hook runs again after a compaction. A rules block left in CLAUDE.md by an older `bus init` is removed.

It works in any terminal or IDE: VS Code, JetBrains, Windows Terminal, tmux, anything. The agents must be **Claude Code** sessions, because edit blocking, notices, rules and usage tracking run on Claude Code hooks.

Give each agent you start yourself its own worktree, then start Claude Code there with an identity. `bus worktree` does both steps and prints the command:

```sh
bus worktree frontend-1 --team frontend
# created: ../Agentic-Chat.worktrees/frontend-1 (branch frontend-1)
# start the agent there:
#   bash:       cd "…/frontend-1" && BUS_AGENT=frontend-1 BUS_TEAM=frontend claude
#   PowerShell: cd "…/frontend-1"; $env:BUS_AGENT='frontend-1'; $env:BUS_TEAM='frontend'; claude
```

Workers need their own worktree because one folder can have only one branch checked out. Agents sharing a folder would see each other's half-finished edits and break each other's test runs.

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

- **Each worker gets its own git worktree** (`<repo>.worktrees/frontend-1`, branch `frontend-1`; see "Worktrees" below) and a headless `claude -p` session. Its prompt holds only the task (join, take the task, test first, commit, `bus task done --report`) plus the few rules it needs. It gets no SessionStart rules (`BUS_SPAWNED=1`), so it doesn't pay for them twice. Hooks come from `--settings .bus/worker-settings.json`, so the worktree stays clean.
- **Lean by default:**
  - Workers start with `--strict-mcp-config` (no MCP servers) and `--setting-sources project,local`, so they don't load your user-level plugins, hooks or MCP tools. `BUS_WORKER_SETTING_SOURCES=all` loads everything.
  - The model is `sonnet` unless you set `BUS_WORKER_MODEL`. `BUS_WORKER_MODEL=default` uses the CLI's own default.
  - `BUS_WORKER_BUDGET` caps each run in USD (`--max-budget-usd`).
- **Token limits:** at most `BUS_MAX_WORKERS` (default **4**, max 16) run at once across the whole bus. Extra spawns queue and start as slots free up, and a task waiting on dependencies doesn't take a slot. A worker **exits as soon as its check passes**, so no session sits idle.
- **Rejected?** The worker runs with `--output-format json`, so the bus learns its session id. A rejected task **resumes that same session** (`--resume`) with a one-line prompt holding the reason, so the worker keeps what it already learned about the code. If the session can't be resumed, the next spawn starts fresh in the same worktree.
- **Exited unfinished?** If a worker exits without handing its task in, its lead gets one notice with the worker's last words (the end of its final message, ≤300 chars) and the log path (`.bus/workers/<name>.log`), so there's usually no need to open the log.
- **Cleanup:** when a spawned worker's task is merged, its worktree is removed and its branch deleted (`git branch -d`, which refuses an unmerged branch). A worktree with uncommitted work is kept and logged; the bus's own `.bus/` doesn't count as uncommitted.
- Spawned workers are never offered other tasks and are not flagged inactive after exiting. Merging and approval work exactly as before.
- **Permissions:** workers run with `--permission-mode acceptEdits`. Edits in the worktree are allowed, but shell commands are limited to an allowlist:
  - `bus` and `git`
  - the task's own done-check command
  - anything in `BUS_WORKER_ALLOW` (comma-separated rules, e.g. `Bash(npx vitest:*),WebFetch`)

  A headless session can't answer a prompt, so anything else is refused. All of this still sits behind the bus edit guard, shell guard and pre-commit guard. `BUS_WORKER_PERMISSION=bypassPermissions` brings back the old unrestricted mode. The command that starts a worker is `BUS_CLAUDE` (default `claude`).

## How messages reach agents

- `bus send @bob ...` is a DM. `bus send @frontend ...` posts to `#frontend` and mentions the team. `bus send #general ...` is a plain channel post.
- An agent's inbox (`bus read` / `bus wait`) holds **only** DMs to it and messages that mention `@its-name` or `@its-team`. Plain channel chatter never shows up there; to see it, run `bus log #chan`.
- Output is one line per message, and long messages are truncated (`bus show <id>` gives the full text). A catch-up shows at most 30 messages.
- **Short messages arrive in the hook notice itself.** If at most 2 messages are waiting and each is one line of ≤200 chars, the PostToolUse notice carries them (`bus: 12 alice>@bob: rebase on main`) and marks them read. That saves the agent a `bus read` call. Bigger batches get the one-line pointer (`bus: 3 new for you (from @alice) — run: bus read`).
- **Waiting costs nothing.** The rules tell agents to run `bus wait 3600` in the background (`run_in_background`) and end their turn. Claude Code wakes them when it exits, so no tokens are spent re-running `bus wait`.
- State keeps the newest 1,000 messages. Older ones move to `.bus/archive.jsonl` (`bus show` on one says it's archived). An inbox never shows more than the newest 30 anyway, so no agent loses anything it would have been shown.

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

### Shared context: `--context` and notes

Re-reading the code to get oriented is the biggest cost of many agents on one codebase. Two things cut it down:

- **`--context a.md,src/lib/db.js`** on `bus task add`: the files a worker should read first. `bus task take` prints them as `read first: …`, so the worker doesn't explore.
- **Notes:** `bus note add <path> "<≤5 lines, ≤600 chars>"` leaves a short summary of a file or `dir/`. `bus task take` prints the notes on anything overlapping the task's files or context (newest 5), in the same call. So the next agent reads a summary instead of the source.
  - `bus note <path>` shows one note, and `bus note list` lists the paths.
  - `bus note rm <path>` removes one (the author or a lead).
  - Notes show who wrote them and how long ago, so stale ones are easy to spot.

### Token usage (`bus usage`)

`bus init` adds a **Stop hook**. After each turn it reads the session transcript, including subagent transcripts, deduplicating by message id. It reports the session's cumulative token counts to the bus and prints nothing, so it costs no tokens.

The bus adds each increase to the agent and to its current task. Turns after a merge still count toward the task it last held. To see the numbers:
- `bus usage` lists totals for all agents, each agent and each task, e.g. `tokens: 1.2M in (96% cached), 41k out`.
- `bus report <id>` ends with the task's line.
- The dashboard's task panel shows it under **Tokens**.

Spawned workers also record their total run cost in USD from the JSON result, and `bus workers` shows it.

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
- Hook notices (PostToolUse) appear once per new batch of messages. They carry short messages inline, otherwise a one-line pointer, and print nothing at all when nothing is waiting.
- `bus hot list` and `bus iface list` read small endpoints (`/api/hot`, `/api/iface`), not the whole state.

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

## Worktrees

The bus creates worktrees itself with plain `git worktree`, so no IDE or other tool is needed.

- **Where:** all of them go in one folder next to the repo, `<repo>.worktrees/<name>`, so you see one extra folder instead of one per worker. Set `BUS_WORKTREE_DIR` to put them elsewhere. They're kept outside the repo so test runners and file watchers don't scan them.
- **Disk:** worktrees share the repo's git history, so each one holds only the checked-out files. Installed dependencies (`node_modules`, virtual environments) are per worktree. If that gets big, a shared package store (pnpm, for example) helps; the bus doesn't manage installs.
- **Making them:**
  - `bus spawn` makes one per spawned worker.
  - `bus worktree <name> --team <t>` makes one for an agent you start yourself (human, the head, or that team's lead). It's idempotent and prints the start command.
  - `bus worktree list` shows them all.
- **Removing them:**
  - A spawned worker's worktree is removed when its task merges.
  - `bus worktree prune` (human or head) removes every idle bus-made worktree. Idle means its agent holds no task, isn't running, and nothing has happened in it for 10 minutes; `--dry-run` shows what would go.
  - Removal never loses work. A worktree with uncommitted changes is kept (the bus's own `.bus/` aside). The branch is deleted only if it's merged (`git branch -d`), so unmerged commits stay on their branch. The empty `<repo>.worktrees` folder is removed with the last worktree.
- `bus join` records each agent's worktree root, so done-checks run there. Agents may also work in worktrees you made some other way, through git or any IDE's worktree feature.

## Development

```sh
npm test
```
