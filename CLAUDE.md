# CLAUDE.md — ambient

## What is this project?

Ambient is an agentic shell layer — a background daemon + CLI + shell hooks that makes any coding agent (Claude Code, Codex, Gemini CLI, Goose, etc.) ambient and context-aware without requiring the user to enter a TUI.

## Architecture

```
src/
├── cli/           # The `r` command (thin client, talks to daemon via Unix socket)
├── daemon/        # Background daemon process (context engine + agent router)
├── agents/        # Agent registry and subprocess router
│   ├── registry.ts   # Built-in agent definitions (CLI flags for each agent)
│   └── router.ts     # Spawns agent subprocesses, streams output
├── context/       # Context engine (tracks shell state from hooks)
│   └── engine.ts     # Maintains cwd, git, commands, exit codes
├── types/         # TypeScript interfaces
└── config.ts      # Configuration loading (~/.ambient/config.json)

shell/
└── ambient.zsh    # Zsh integration (preexec/precmd/chpwd hooks + Alt+A widget)
```

## Build & run

```bash
pnpm install
pnpm build
node dist/cli/index.js "test query"          # run CLI directly
node dist/daemon/index.js                     # run daemon directly
```

## IPC protocol

Daemon listens on a Unix socket. Messages are newline-delimited JSON.

**Request**: `{ type: "query" | "context-update" | "ping" | "shutdown" | "status", payload: {...} }`
**Response**: `{ type: "chunk" | "done" | "error" | "status", data: "..." }`

Responses stream — multiple `chunk` messages followed by one `done`.

## Key design decisions

1. **No TUI** — this is a shell companion, not a terminal app
2. **Agent-agnostic** — routes to any agent via subprocess invocation
3. **Context via prompt injection** — prepends shell context to the user's prompt before sending to the agent
4. **Daemon pattern** — persistent process for context continuity, auto-starts on first `r` invocation
5. **Minimal shell integration** — ~80 lines of zsh, uses standard hooks (add-zsh-hook)
6. **Zero dependencies at runtime** except Node.js (zsh integration uses socat for non-blocking socket writes)

## TypeScript guidelines

- Follow the conventions in the parent workspace CLAUDE.md
- Prefer `const` over `let`, early returns, guard clauses
- No classes unless hiding private state (ContextEngine is the exception — it encapsulates mutable state)
- Structured logging to stderr from the daemon
- All IPC is newline-delimited JSON over Unix sockets
