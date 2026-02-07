# ambient

**An agentic shell layer that makes any coding agent ambient and context-aware — without entering a TUI.**

Ambient is not a coding agent. It's the layer that makes every coding agent better. It sits in your shell, watches what you do, and gives any agent the context it needs — your cwd, git state, recent commands, project structure — so you can invoke AI naturally alongside your normal workflow.

## How it works

```
┌─────────────────────────────────────────────────┐
│  Your normal zsh (unmodified)                   │
│                                                 │
│  Shell hooks (preexec/precmd/chpwd) feed the    │
│  daemon your commands, exit codes, and state.   │
│                                                 │
│  r "your question"     → invoke default agent   │
│  r -a codex "fix this" → pick a specific agent  │
│  cat log | r "explain" → pipe context in        │
└──────────────┬──────────────────────────────────┘
               │ Unix socket
┌──────────────▼──────────────────────────────────┐
│  Ambient Daemon                                 │
│  • Persistent context engine                    │
│  • Agent router (claude, codex, gemini, goose…) │
│  • Streams responses back to your terminal      │
└─────────────────────────────────────────────────┘
```

## Quick start

```bash
# Install dependencies and build
pnpm install && pnpm build

# Link the CLI globally
pnpm link --global

# Add shell integration to your .zshrc
echo 'source /path/to/ambient/shell/ambient.zsh' >> ~/.zshrc
source ~/.zshrc

# Start using it
r "what does this project do"
r -a codex "fix the failing tests"
git diff | r "review this"
```

## Usage

```bash
# Natural language query (uses default agent)
r "refactor the auth module to use JWT"

# Choose a specific agent
r --agent claude "explain this error"
r --agent codex "write tests for auth.ts"
r --agent gemini "summarize the architecture"

# Pipe input as context
cat error.log | r "why is this failing"
git diff | r "review these changes"

# Daemon management
r daemon start
r daemon stop
r daemon status
```

## Supported agents

Any coding agent with a headless CLI mode works. Built-in support for:

| Agent | Command | Status |
|-------|---------|--------|
| Claude Code | `claude -p` | ✅ |
| Codex CLI | `codex exec` | ✅ |
| Gemini CLI | `gemini -p` | ✅ |
| Goose | `goose run -t` | ✅ |
| Aider | `aider -m` | ✅ |
| Copilot CLI | `copilot -p` | ✅ |
| OpenCode | `opencode run` | ✅ |
| gptme | `gptme --non-interactive` | ✅ |

## Shell integration

The zsh integration installs three hooks:

- **preexec** — tells the daemon what command is about to run
- **precmd** — tells the daemon the exit code and current state
- **chpwd** — tells the daemon when you change directories

Plus **Alt+A** for inline AI suggestions in your command buffer.

Your zsh runs completely unmodified — all your dotfiles, oh-my-zsh, aliases, and keybindings work exactly as before.

## Configuration

```bash
# Config lives at ~/.ambient/config.json
r config
```

```json
{
  "defaultAgent": "claude",
  "logLevel": "info"
}
```

## Architecture

- **Daemon** (`src/daemon/`) — persistent background process on a Unix socket. Maintains the context engine and routes requests to agents.
- **CLI** (`src/cli/`) — the `r` command. Thin client that talks to the daemon. Auto-starts the daemon on first use.
- **Context Engine** (`src/context/`) — tracks cwd, git state, recent commands, exit codes, project type. Fed by shell hooks.
- **Agent Router** (`src/agents/`) — invokes any agent as a subprocess with context-enriched prompts. Streams output back.
- **Shell Integration** (`shell/`) — thin zsh hooks (~80 lines) that feed the daemon and expose the `r` function.

## License

MIT
