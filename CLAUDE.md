# Agentic Chat

A local chat + file-claim + task system so many Claude Code agents can work on one codebase without overwriting each other.

**Read [DESIGN.md](DESIGN.md) before building anything.** It is the agreed spec — follow it, and ask the user before changing any decision in it.

Key constraints:
- Minimal token usage for agents is the top priority. Agents read only what's addressed to them; no polling.
- Node.js, zero dependencies, runs locally.
- IDE-agnostic: don't depend on Orca or any IDE feature. The bus must work from any terminal; it manages its own worktrees with plain git. Agents are Claude Code sessions (hooks are required).
- Follow the build order in DESIGN.md §8.
