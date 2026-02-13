# Ambient

Agentic shell layer — background daemon + CLI + shell hooks making any coding agent (Claude Code, Codex, Gemini CLI, etc.) ambient and context-aware without a TUI.

## Architecture

```
src/
├── cli/           # `r` command (thin client, Unix socket → daemon)
├── daemon/        # Background daemon (context engine + agent router)
├── agents/        # Agent registry + subprocess router
├── context/       # Context engine (tracks shell state from hooks)
├── types/         # TypeScript interfaces
└── config.ts      # Config loading (~/.ambient/config.json)

shell/
└── ambient.zsh    # Zsh integration (preexec/precmd/chpwd hooks + Alt+A)
```

## Build & Run

```bash
pnpm install && pnpm build
node dist/cli/index.js "test query"    # CLI directly
node dist/daemon/index.js              # Daemon directly
```

## IPC Protocol

Unix socket, newline-delimited JSON.
- **Request**: `{ type: "query"|"context-update"|"ping"|"shutdown"|"status", payload }`
- **Response**: Multiple `chunk` messages → one `done` (streaming)

## Design Decisions

1. No TUI — shell companion only
2. Agent-agnostic — routes to any agent via subprocess
3. Context via prompt injection — prepends shell context to user's prompt
4. Daemon pattern — persistent for context continuity, auto-starts on first `r`
5. Minimal shell integration — ~80 lines of zsh, standard hooks
6. Zero runtime deps except Node.js (zsh uses socat for non-blocking socket writes)

## Shell Integration Rules (ambient.zsh)

Sourced in `.zshrc` — runs on every new tab, split, pane, and scripted shell launch.

### Never do in ambient.zsh

1. **`exec` to replace shell** — causes double init, breaks TUI apps (Claude Code, vim), corrupts iTerm2 splits
2. **Synchronous Node.js during init** — blocks prompt 2-3s per tab. Use cached output files instead
3. **Pseudo-TTY wrappers** (`script(1)`, socat PTY, `unbuffer`) — corrupts escape sequences for alternate screens, mouse, iTerm2 features

### Safe output capture

- Use the `rc` wrapper for per-command capture
- Use `preexec`/`precmd` hooks for passive logging without wrapping the shell
