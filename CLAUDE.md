# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Ambient

Agentic shell layer — background daemon + CLI + shell hooks making any coding agent (Claude Code, Codex, Gemini CLI, etc.) ambient and context-aware without a TUI. It's not a coding agent; it's the context layer that makes every coding agent better.

## Build & Development

```bash
pnpm install && pnpm build    # Build (tsc, outputs to dist/)
pnpm dev                      # Watch mode
pnpm typecheck                # Type check without emitting
pnpm test                     # Run all tests (vitest)
pnpm test:watch               # Watch mode tests
vitest run tests/memory/store.test.ts  # Single test file
pnpm reload                   # Rebuild + restart daemon + re-source shell hooks
```

The `lint` script (`eslint src/`) exists but no ESLint config is present — use `pnpm typecheck` for validation.

## Architecture

Three entry points, one data flow:

```
Shell hooks (ambient.zsh) ──→ Daemon (Unix socket) ──→ Agent subprocess
                                    ↕
                              Memory store (disk)
                                    ↕
                              MCP server (stdio)
```

### Core Modules

- **`src/cli/index.ts`** — The `r` command. Thin client that sends IPC to the daemon. Auto-starts daemon on first use. Handles subcommands: `daemon`, `mcp-serve`, `setup`, `remember`, `memory`, `capture`, `notify`, `suggest`, `assist`, `agents`, `compare`, `templates`, `new`.
- **`src/daemon/index.ts`** — Persistent background process on Unix socket (`$XDG_RUNTIME_DIR/ambient-<uid>.sock`). Maintains context engine, routes to agents, manages sessions. Auto-shuts down after 24h idle.
- **`src/mcp/server.ts`** — MCP server (12 tools, 5 resources) using `@modelcontextprotocol/sdk`. Runs via `r mcp-serve` on stdio transport. Falls back to reading disk directly when daemon is down.
- **`src/agents/router.ts`** — Spawns agent subprocesses, streams output via `onChunk` callbacks. `registry.ts` defines 8 built-in agents with capability tags and priority. `selector.ts` auto-selects best agent for a query.
- **`src/context/engine.ts`** — Tracks cwd, git state, recent commands (ring buffer, max 50), exit codes, project type. Detects 9 project types (Node, Rust, Go, Python, etc.). Detects repeated failures (3+ in 5 min).
- **`src/memory/`** — Two-level persistent store: project (cross-branch) + task (per-branch). TF-IDF search across all projects. LLM-powered compaction via Haiku. Jaccard similarity for decision supersede detection (>40% keyword overlap → replace). Files stored in `~/.ambient/memory/projects/<hash>/`.
- **`src/assist/fast-llm.ts`** — Direct Anthropic API streaming for instant inline assist (bypasses agent subprocess).
- **`src/setup/`** — `claude-md.ts` injects versioned memory instructions into `~/.claude/CLAUDE.md`. `claude-hooks.ts` registers ambient in Claude Code's MCP config.
- **`shell/ambient.zsh`** — ~325 lines of zsh hooks (preexec/precmd/chpwd), Alt+A widget, `rc` output capture wrapper, natural language detection, whitelist-based auto-capture for build tools.

### IPC Protocol

Unix socket, newline-delimited JSON.
- **Request**: `{ type: "query"|"context-update"|"ping"|"shutdown"|"status"|..., payload }`
- **Response**: Multiple `chunk` messages → one `done` (streaming)

## Key Patterns

- **ESM throughout** — `"type": "module"` in package.json, `NodeNext` module resolution. All imports need `.js` extensions.
- **No DI framework** — Direct imports and singletons. `ContextEngine` instantiated in daemon.
- **Fire-and-forget writes** — Memory writes use `setTimeout(() => { ... }, 0)` to avoid blocking responses.
- **Graceful degradation** — MCP server reads from disk when daemon is down. Context engine returns null/empty on failures.
- **Git-based memory keys** — Project key: `SHA256(remote || gitRoot || cwd)`. Task key: sanitized branch name.
- **Memory compaction** — Thresholds: 40 project events, 80 task events. Haiku summarizes oldest low/medium events. High-importance events are never compacted.
- **Atomic disk writes** — Memory uses write-then-rename for crash safety.

## TypeScript Config

Strict mode with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`. Target ES2024. Only runtime deps are `@modelcontextprotocol/sdk` and `zod`.

## Shell Integration Rules (ambient.zsh)

Sourced in `.zshrc` — runs on every new tab, split, pane, and scripted shell launch.

### Never do in ambient.zsh

1. **`exec` to replace shell** — causes double init, breaks TUI apps (Claude Code, vim), corrupts iTerm2 splits
2. **Synchronous Node.js during init** — blocks prompt 2-3s per tab. Use cached output files instead
3. **Pseudo-TTY wrappers** (`script(1)`, socat PTY, `unbuffer`) — corrupts escape sequences for alternate screens, mouse, iTerm2 features

### Safe output capture

- Use the `rc` wrapper for per-command capture
- Use `preexec`/`precmd` hooks for passive logging without wrapping the shell

## Testing

Tests live in `tests/memory/` (7 files covering the memory subsystem). No tests for CLI, daemon, or agents — those are verified via manual integration testing. Tests use temp directories with cleanup in `beforeEach`/`afterEach`.
