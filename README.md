# ambient

**Your terminal, with memory.**

[![CI](https://github.com/averyjennings/ambient/actions/workflows/ci.yml/badge.svg)](https://github.com/averyjennings/ambient/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ambient-shell)](https://www.npmjs.com/package/ambient-shell)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Shell hooks observe your commands, exit codes, and working directory. A background daemon maintains context and persistent memory. When any coding agent -- Claude, Codex, Gemini, Goose, Aider -- is invoked, it gets the full picture. No TUI, no wrapper, just context.

<p align="center">
  <img src="docs/demo.gif" alt="ambient demo" width="800">
</p>

## Quick Start

**Prerequisites:** Node.js >= 20, zsh / bash 4+ / fish 3.1+

```bash
# Install
git clone https://github.com/averyjennings/ambient.git
cd ambient && pnpm install && pnpm build && pnpm link --global

# Set up everything (shell hooks, daemon, agent integrations)
ambient init

# Start using it
r "what does this project do"
```

For detailed instructions, see [Getting Started](docs/getting-started.md).

## Features

### Context Awareness

Shell hooks track your working directory, git branch, recent commands, and exit codes. Zero config -- just source the shell integration and everything is tracked automatically. Your shell runs completely unmodified; all your dotfiles, frameworks, and keybindings work exactly as before.

### Persistent Memory

Two-level memory system: project-wide (survives branch deletion) and per-branch (archived on merge). TF-IDF search across all projects, automatic compaction of old events, and Jaccard-based supersede detection for evolving decisions. All stored as plain JSON files in `~/.ambient/memory/`.

```bash
r remember "chose Postgres over SQLite for production"
r memory                    # view memories
ambient memories search "database"   # search across projects
```

### Multi-Agent Support

Eight built-in agents, all invoked as subprocesses with context-enriched prompts:

| Agent | Command | Session Support |
|-------|---------|:--------------:|
| Claude Code | `claude -p` | multi-turn |
| Codex CLI | `codex exec` | -- |
| Gemini CLI | `gemini -p` | -- |
| Goose | `goose run -t` | -- |
| Aider | `aider --message` | -- |
| Copilot CLI | `copilot -p` | -- |
| OpenCode | `opencode run` | multi-turn |
| gptme | `gptme --non-interactive` | -- |

```bash
r "refactor the auth module"          # default agent
r -a codex "write tests for auth.ts"  # specific agent
r compare -a claude,gemini "explain"  # compare agents side-by-side
r agents                              # list installed agents
```

### Inline Assist

Type natural language directly in your terminal and get instant answers powered by Claude Haiku. No need to prefix with `r` -- the shell hooks detect natural language and route it automatically.

```
what does this function do          # detected as NL, routed to assist
why did the build fail              # instant answer with captured output
```

Press **Alt+A** to convert a natural language description in your command buffer into a shell command.

### Templates

Built-in templates combine a prompt with an optional command whose output provides context:

```bash
r review          # git diff + code review
r review-staged   # git diff --cached + review
r commit          # git diff --cached + commit message
r fix             # fix last failed command
r test src/foo.ts # generate tests
r explain         # explain code or output
r templates       # list all templates
```

Custom templates go in `~/.ambient/config.json`.

### Output Capture

The `rc` wrapper captures command output for ambient to use as context:

```bash
rc pnpm build     # build output captured
r fix             # agent sees the captured error
```

In zsh and fish, whitelisted build tools (`pnpm`, `cargo`, `pytest`, `make`, `tsc`, etc.) are auto-wrapped -- no need to type `rc` explicitly.

### Memory Browsing

Full-featured memory management from the command line:

```bash
ambient memories                        # browse (newest first)
ambient memories --type decision        # filter by type
ambient memories --since 7d             # filter by recency
ambient memories search "auth"          # search across projects
ambient memories delete <id>            # delete an event
ambient memories edit <id>              # edit in $EDITOR
ambient memories export > backup.json   # export all memory
ambient memories import backup.json     # import from backup
ambient memories stats                  # aggregate statistics
```

### Privacy Controls

All data stays on your machine. API calls can be disabled entirely, directories can be excluded, and secrets are automatically redacted.

```bash
ambient privacy                         # show privacy status
ambient privacy local-only on           # disable all API calls
ambient privacy monitoring off          # disable passive monitoring
```

See [Privacy](docs/privacy.md) for full details.

### Cost Tracking

Track API token usage and costs with daily breakdowns and budget limits:

```bash
ambient usage                # today's usage + all-time totals
ambient usage --json         # raw JSON output
ambient usage --reset --yes  # clear usage data
```

### MCP Integration

12 tools and 5 resources for agents that support the Model Context Protocol. Claude Code, and any MCP-aware agent, can access ambient's context and memory directly.

**Resources:** `ambient://context`, `ambient://history`, `ambient://project`, `ambient://memory/project`, `ambient://memory/task`

**Tools:** `get_shell_context`, `get_command_history`, `get_project_info`, `get_task_context`, `get_decisions`, `get_recent_output`, `search_all_memory`, `list_memory_events`, `store_decision`, `store_task_update`, `store_error_resolution`, `update_memory`, `delete_memory`

Register the MCP server in your agent's config as:

```
node /path/to/ambient/dist/cli/index.js mcp-serve
```

## Supported Shells

| Feature | zsh | bash 4+ | fish 3.1+ |
|---------|:---:|:-------:|:---------:|
| Passive hooks (preexec/precmd/chpwd) | yes | yes | yes |
| Natural language interception | yes | -- | yes |
| Alt+A command suggestion | yes | yes | yes |
| Auto-capture (whitelisted commands) | yes | -- | yes |
| `rc` output capture wrapper | yes | yes | yes |
| `command_not_found` handler | yes | yes | yes |

Bash limitations: no Enter-key natural language interception (no ZLE equivalent) and no auto-capture wrapping (DEBUG trap cannot modify commands). Use `rc <cmd>` explicitly for output capture, and prefix queries with `r` for natural language.

## Observability

```bash
r status              # full daemon dashboard (pid, uptime, memory, sessions, usage)
r status --json       # raw JSON
r health              # quick diagnostic checks
r logs                # last 50 lines of daemon log
r logs -f             # follow log in real-time
r logs -n 200         # last N lines
```

## Configuration

Config file: `~/.ambient/config.json`

```json
{
  "defaultAgent": "claude",
  "logLevel": "info",
  "llm": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001"
  },
  "privacy": {
    "localOnly": false,
    "passiveMonitoring": true
  },
  "templates": {
    "security": {
      "command": "git diff",
      "prompt": "Audit these changes for security issues.",
      "description": "Security review"
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultAgent` | `"claude"` | Agent for `r "query"` (or `"auto"` for auto-selection) |
| `logLevel` | `"info"` | Daemon log verbosity |
| `templates` | (built-ins) | Custom templates merged with built-ins |
| `privacy.localOnly` | `false` | Disable all API calls |
| `privacy.passiveMonitoring` | `true` | Observe agent tool calls |
| `llm.provider` | `"anthropic"` | LLM provider: `anthropic`, `ollama`, `openai-compat` |
| `llm.model` | `"claude-haiku-4-5-20251001"` | Model for fast LLM calls |
| `dailyBudgetUsd` | (none) | Daily API cost limit |

## LLM Providers

Ambient uses a fast LLM for inline assist, memory extraction, and compaction. This is separate from the agents you invoke.

**Anthropic (default):** Set `ANTHROPIC_API_KEY` in your environment. Uses Claude Haiku.

**Ollama (fully local):** Configure `"llm": { "provider": "ollama", "model": "llama3.2" }`. No API key needed, nothing leaves your machine.

**OpenAI-compatible:** Configure `"llm": { "provider": "openai-compat", "baseUrl": "https://your-endpoint/v1" }`. Set `OPENAI_API_KEY`.

## Privacy

All data stays on your machine. No cloud storage, no database, plain JSON files. API calls can be fully disabled with local-only mode. Secrets are automatically redacted before any data is sent. See [Privacy](docs/privacy.md) for the complete details.

## Architecture

Three entry points, one data flow: shell hooks feed the daemon, the daemon maintains context and memory, and agents get called with enriched prompts. ~5,100 lines of TypeScript + 325 lines of zsh, two runtime dependencies (`@modelcontextprotocol/sdk` and `zod`), no database, no bundler. See [Architecture](docs/ARCHITECTURE.md) for the deep dive.

## Documentation

- [Getting Started](docs/getting-started.md) -- installation, first session, configuration
- [How Memory Works](docs/memory-guide.md) -- two-level memory, search, compaction, lifecycle
- [Privacy](docs/privacy.md) -- data collection, API calls, opting out
- [Architecture](docs/ARCHITECTURE.md) -- technical deep dive into every subsystem

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for setup, development workflow, and guidelines.

```bash
pnpm install && pnpm build    # build
pnpm test                     # 379 tests
pnpm typecheck                # strict mode
pnpm dev                      # watch mode
```

## License

MIT
