# Agentic Chat — Design

A local coordination layer that lets many Claude Code agents work on one codebase at the same time without overwriting each other's code. Agents talk through team channels and @mentions, own files through claims, and hand finished work to a lead agent who merges it after the human approves.

**Top priority: minimal token usage.** Every feature below is shaped so agents only ever read what they actually need. When in doubt, choose the option that costs agents fewer tokens.

---

## 1. Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Human** | You | Opens each Claude Code session manually. Gives the lead the goal. Approves or rejects merges. Watches the dashboard and can post anywhere. |
| **Lead agent** | One Claude Code session | Splits the goal into tasks, assigns them, writes each task's done-check, owns the hot files, reviews and merges finished work after human approval, handles escalations and inactive agents. The only agent with the big picture. |
| **Head + team leads** (optional, `BUS_ROLE`) | One head, one lead per team | For multi-team work, the lead role splits in two. The **head** owns hot files, interfaces and change requests, can manage any team, and reviews and merges tasks a lead owns itself. Each **team lead** (`BUS_ROLE=lead`, with `BUS_TEAM`) plans, reviews and merges only its own team's tasks, and is notified about them. An agent named `lead` without a role is the head. See README "Team leads". |
| **Worker agents** | Many Claude Code sessions | Each runs in its **own git worktree**, belongs to **one team**, works **one task at a time**. |

The human starts the head and lead sessions (and may start workers) in any terminal or IDE with a name and team. `bus worktree <name> --team <t>` makes a worker's worktree and prints the start command. Leads may also **spawn workers** themselves (`bus spawn <task>`): one headless Claude session in its own worktree per task, at most `BUS_MAX_WORKERS` (default 4) at once, each exiting once its check passes. See README "Lead-spawned workers".

Spawned workers are **lean and scoped**:
- They load no MCP servers and no user-level settings, and default to the `sonnet` model.
- They run in `acceptEdits` mode. Shell commands are limited to `bus`, `git`, the task's done-check and `BUS_WORKER_ALLOW`; `BUS_WORKER_PERMISSION=bypassPermissions` opts out.
- A rejected worker **resumes its own session** (`--resume`, from the `--output-format json` session id) instead of starting cold.
- After merge, the bus removes the worktree and branch it created, unless there is uncommitted work.

---

## 2. Workflow

1. **Human → lead:** the human starts the lead session and describes what they need.
2. **Lead plans:** the lead creates tasks on the board. Each task has:
   - title and a self-contained brief (goal, constraints, interfaces it must match) — written so the worker never needs chat history
   - **files** it owns (files, directories ending in `/`, or globs)
   - **context** (optional): files the worker should read first, so it doesn't explore. Shown on take, together with any **notes** on the task's files (see §4).
   - **done-check**: a shell command that must pass (e.g. `npm test -- users`)
   - **dependencies** on other tasks (optional)
   - **assignee**: a specific agent or a team
3. **Workers start:** the human opens worker sessions, each with a name + team (e.g. `frontend-1` / `frontend`). On startup a worker registers and picks up the task assigned to it; a team-assigned task goes to the first free member of that team. A task whose dependencies aren't merged yet can't be taken.
4. **Claim on take:** taking a task claims its files. Edits to files claimed by anyone else are blocked (see §5).
5. **Done-check:** the worker commits its work on its branch, then runs `bus task done <id>`. The bus refuses if the worktree has uncommitted changes (`git status --porcelain`; `--allow-dirty` overrides, and the bus's own `.bus/` is ignored). It then runs the task's done-check **in that worker's worktree** and records the worktree's HEAD commit on the merge request. If it fails, the task stays in progress and the worker sees the failure output (truncated). The lead does **not** re-run the check after merging.
6. **Merge request:** a passing task becomes a merge request with a **report**. The worker supplies at most 3 short lines (`--report`: what was built, problems, anything unfinished; more is refused before the check runs). The bus adds everything it already knows: agent, role and team, time since take, files claimed, commit, check runs and the final result, and messages sent and received grouped by counterpart. That costs no agent tokens. The report is stored on the task and appended to `.bus/reports.md`. Only the lead and the human read it (`bus report <id>`, dashboard), and it never enters an agent inbox. The lead reviews it and asks the human to approve.
7. **Human approval — two ways, both supported:**
   - **Approve / Reject** buttons on the dashboard
   - replying in chat (e.g. `@lead approve #4` / `@lead reject #4 reason`)
8. **Merge:** after approval the lead is told to merge the **reviewed commit** (`merge <sha7>`, not the branch, so later unreviewed commits can't ride along). The merge must be a plain `git merge <sha>`, because squash and rebase rewrite the commit. The lead then runs `bus task merged <id>`. The bus verifies that the recorded commit is in the main branch (`git merge-base --is-ancestor`, run in the lead's worktree or the repo the server started in). The main branch is `BUS_MAIN`, defaulting to `main`, or `master` if `main` doesn't exist. If the commit isn't there, it refuses; `--force` lets the lead override. Then automatically:
   - the task's claims are released
   - owners of tasks that depended on it are mentioned: `#4 merged — rebase and start #7`

---

## 3. Communication

### Channels and mentions
- One channel per team: `#frontend`, `#backend`, … plus `#general`.
- Mentions: `@agent-name`, `@team-name` (everyone on that team), `@lead`, `@you` (the human).
- Workers may DM each other directly — they don't route through the lead (relaying would cost the lead tokens).

### What an agent receives (mention-only by default)
An agent's inbox contains **only**:
- DMs to it
- messages mentioning `@its-name` or `@its-team`
- updates about its own task (merge, rejection, dependency ready, reassignment)

It does **not** read whole channels unless it explicitly asks (`bus log #frontend`).

### Activity log (dashboard only)
Claims, releases, task status changes, and inactivity notices go to an **activity log** that only the dashboard shows. Agents never read it.

---

## 4. Token-minimization rules

These are requirements, not nice-to-haves.

1. **No polling.** Agents never loop on "check messages".
   - A Claude Code hook (PostToolUse) adds a notice to the agent's context **only when something is waiting**. When nothing is waiting it outputs nothing → zero tokens.
   - **Short messages are delivered in the notice itself:** up to 2 one-line messages of ≤200 chars, which then count as read. That saves a `bus read` call. Bigger batches get one line: `bus: 3 new for you (from @alice) — run: bus read`.
   - When blocked, an agent runs `bus wait`, which blocks at zero token cost until a message for it arrives. Agents are told to run `bus wait 3600` in the background (`run_in_background`) and end their turn, so long waits cost no repeated tool calls.
2. **Self-contained task briefs** so workers don't read history, plus **`--context`** (files to read first) and **notes**. A note is ≤5 lines on a file or dir, left by an agent that learned it. Notes overlapping the task's files are printed by `bus task take` in the same call, so the next agent reads a summary instead of the source.
3. **Automatic handoffs** for dependencies — nobody asks "is it ready yet?".
4. **Compact CLI output:** one line per message, no decoration. Long messages truncated with `bus show <id>` for the full text. Catch-up after a long gap is capped (e.g. last 30, with a "N older skipped" note).
5. **Routine events stay out of agent inboxes** (activity log only).
6. **Tiny agent instructions, only for agents:**
   - The rules (about 8 lines) are injected by a **SessionStart hook** only when `BUS_AGENT` is set, never written to CLAUDE.md. Workers get the worker lines and leads one more; they are re-injected after a compaction.
   - Spawned workers skip them, because their prompt already carries what they need.
7. **Done-check output is truncated** to the last relevant lines on failure. A worker that exits unfinished sends its lead its last words (≤300 chars), not just a log path.
8. **Measure it.** A Stop hook reads each session's transcript and reports cumulative token counts to the bus, silently. The bus adds the increase to the agent and its task, shown by `bus usage`, `bus report` and the dashboard. Spawned workers also record USD cost from their JSON result.

---

## 5. Files, claims, and worktrees

- **Worktrees:** every worker has its own git worktree/branch, so agents physically can't overwrite each other's files. Branches alone aren't enough, because one folder has one checked-out branch.
  - The bus creates them with plain `git`, in one folder `<repo>.worktrees/<name>` (or `BUS_WORKTREE_DIR`).
  - It removes a spawned worker's worktree after merge, and any idle one on `bus worktree prune`.
  - Removal never loses work: dirty worktrees are kept, and unmerged branches stay.
- **Claims** prevent two branches from changing the same file, so merges stay clean.
- Claim paths are **repo-relative with forward slashes** (`src/api/users.ts`), so they mean the same thing in every worktree. Case-insensitive on Windows.
- A claim can be a file, a directory (`src/api/` covers everything inside), or a glob (`src/**/*.css`).
- **Enforcement:** a Claude Code **PreToolUse** hook on `Edit|Write|MultiEdit|NotebookEdit` asks the bus whether the file is free for this agent.
  - Claimed by someone else → block (exit code 2) with a short message telling the agent who owns it and how to ask them.
  - Free → allow. (Optionally auto-claim on first edit.)
  - Bus not running or `BUS_AGENT` unset → allow silently (never get in the way).
- **Shell writes:** the hook above only sees Claude Code's edit tools. A **git pre-commit hook**, installed by `bus init`, closes the gap at commit time. It checks every staged file and blocks the commit if a file is claimed by another agent, or is a hot file and the committer isn't the lead. It allows the commit when `BUS_AGENT` is unset (the human), when the bus is down, or when the lead concludes a merge. Workers' merge commits are checked like any other. Any existing hook is kept as `pre-commit.pre-bus` and run first. Shell writes can still change the working tree, but they can't be committed.
- **Bus down is visible:** when a hook can't reach the bus while `BUS_AGENT` is set, it allows the action and prints `bus: server unreachable — edits are NOT being guarded` once. A marker in the temp dir, keyed on agent and port, keeps it to once and is cleared when the bus answers again.
- **Optional identity proof (`BUS_AUTH=1`, off by default):** `bus join` issues a per-agent token, stored in `<worktree>/.bus/agents/<name>.token` (git-ignored). The server stores only its hash and requires the token on every later request from that agent. `bus auth reset <agent>` (human) recovers a lost one.
- **Human lock:**
  - `bus serve` writes a fresh human token to `~/.agentic-chat/<port>.human.token`, outside every repo, and prints `http://127.0.0.1:<port>/#t=<token>`.
  - The dashboard keeps it in `sessionStorage` and sends it on every request. EventSource can't set headers, so the SSE stream takes it as `?t=`. Human CLI commands read the file.
  - With `BUS_AUTH=1`, identity-less requests (or the name `you`) without it get 401.
  - `bus init` adds a PreToolUse hook on `Bash|PowerShell` for agent sessions. It blocks `bus approve|reject|auth`, those API endpoints, any unsetting or overriding of `BUS_AGENT`, and access to `~/.agentic-chat`, each with a one-line reason. It also adds deny rules for `Read`/`Edit(~/.agentic-chat/**)`.
- **Threat model, honestly:** all of the above guards against agents' mistakes and casual misuse, not against a malicious process running as the same OS user. Such a process can read the token directory with tools the hooks don't see, edit settings or git hooks, or call the 127.0.0.1 API directly. Shell pattern matching is best-effort. Real isolation needs a separate OS user or a container.

### Hot files — one owner
Shared files everyone needs (`package.json`, lockfiles, shared types, global config, route registries) are **owned by the lead**. Workers request changes instead of editing:

```
bus request package.json "add zod ^3"
```

The lead applies or declines the request.

### Interface changes
- Shared interfaces (API contracts, shared types, DB schema) are claimed by one owner.
- Files can be marked as **interfaces**, with a list of consuming teams.
- When an owner edits an interface file, the bus reminds them (via the hook notice) to `@mention` the consuming teams describing the change. Announcing is required.

### Claim lifetime and inactive agents
- Claims are released when the task is **merged** (or dropped/reassigned).
- **No automatic expiry.** Instead:
  - An agent silent for **30 minutes** (configurable) is marked **inactive** on the dashboard and the lead is notified.
  - Only the **human or the lead** can release an inactive agent's claims or reassign its task: `bus task reassign <id> <agent>`.
- Any bus command or hook call from an agent counts as activity.

---

## 6. Dashboard

Local web page served by the bus. It's one self-contained file with no dependencies, built on the same `/api/state` and SSE data. It's designed to be quiet: space instead of boxes, color only for meaning, persimmon only when the human must act, and AA contrast in light and dark. It contains:
- a "Needs you" area first: merge requests (with report) and unread messages to the human
- agents (name, team, task, active/inactive), in tabs Active · Waiting (blocked in `bus wait`, from a live `waiting: true` on `/api/state`) · Idle · Done · Inactive, with per-agent history and reports
- task board (status, owner, dependencies, done-check result)
- claims
- team channels + DMs feed, with a composer so the human can post anywhere
- **merge requests with Approve / Reject buttons**
- activity log
- live updates (Server-Sent Events)

---

## 7. Proposed CLI surface (`bus`)

Agent identity comes from env vars set when the human starts the session: `BUS_AGENT` (name) and `BUS_TEAM` (team).

```
bus serve                               start the server + dashboard; prints the dashboard link with the human token
bus dashboard [--no-open]               (human) print the current tokened dashboard link and open it in the browser
bus init [project]                      add hooks + agent instructions to a project

bus join                                register (name/team from env)
bus who                                 list agents
bus send [#channel|@agent|@team] text   post
bus read                                my inbox (mention-only)
bus wait [secs]                         block until something arrives for me
bus show <msg-id>                       full text of a truncated message
bus log [#channel] [n]                  explicitly read a channel

bus claim <paths...> [-m why]
bus release <paths...> | --all
bus claims [--mine]
bus request <hot-file> "change"         ask the lead to change a hot file

bus task add "title" --files a,b/ --check "cmd" [--context x,y] [--after 3,4] [--for agent|team]   (lead)
bus task list [--mine]
bus task take <id>
bus task done <id> ["summary"] [--report "≤3 lines"] [--allow-dirty]   needs committed work; runs the done-check → merge request + report
bus report <id>                         (lead/human) print the task's report
bus task merged <id> [--force]          (lead) verifies the commit is in main, then releases claims
bus task reassign <id> <agent>          (lead/human)
bus approve <id> | bus reject <id> "why" (human, also via dashboard)
bus auth reset <agent>                  (human) drop an agent's token when BUS_AUTH=1
bus note add <path> "≤5 lines" | <path> | list | rm <path>   shared notes on a file or dir/
bus usage                               tokens per agent and per task
bus worktree <name> --team <t>          (human/head/team lead) worktree + branch for an agent started by hand
bus worktree list | prune [--dry-run]   bus-made worktrees; prune removes idle, clean ones (human/head)
```

---

## 8. Implementation notes

- **Node.js, zero dependencies** (Node 18+ for built-in `fetch`). Single local HTTP server, JSON file persistence, SSE for the dashboard, long-polling for `bus wait`.
- Binds to `127.0.0.1` only.
- Persistence shape (epoch-ms timestamps):
  `{ messages[], agents{}, teams{}, claims[], tasks[], mergeRequests[], hotFiles[], interfaces[] }`
- `bus init` merges its hooks into an existing `.claude/settings.json` without clobbering other settings. The hooks are PreToolUse edit and shell guards, the PostToolUse notice, SessionStart rules and Stop usage. It does **not** write agent rules to CLAUDE.md, because every session in the project would pay for them. It removes a `<!-- agent-bus -->` block left there by an older version.
- State keeps the newest 1,000 messages; older ones are appended to `archive.jsonl` next to the state file. Because inboxes are capped at 30, no agent loses a message it would have been shown. The CLI and hooks import only small modules (the port lives in `constants.js`); only `bus serve` loads the server.

### IDE-agnostic
The bus depends on no IDE. It runs in any terminal, and it creates and removes worktrees itself with plain `git`; earlier versions deferred worktrees to the Orca IDE. The only requirement is that agents are Claude Code sessions, since the guards, notices, rules and usage tracking are Claude Code hooks. The git pre-commit guard and the CLI work for any agent.

### Suggested build order
1. Server core: agents/teams, messages with mention-only inbox, claims, persistence
2. `bus` CLI for the above
3. PreToolUse edit-guard hook + `bus init`
4. Tasks: dependencies, done-checks, merge requests, approvals, auto-handoff
5. PostToolUse notification hook (zero output when nothing is waiting)
6. Dashboard
7. Hot files, interface alerts, inactivity handling
