# Privacy

Ambient is designed to keep your data local. This document explains exactly what is collected, where it goes, and how to control it.

## What Data Ambient Collects

- **Shell commands and exit codes** -- the last 50 commands are held in daemon memory. They are never written to disk and are lost when the daemon restarts.
- **Git state** -- current branch name and dirty flag. Detected via `git` commands on directory change and after each command.
- **Current working directory** -- tracked so agents know where you are.
- **Memory events** -- decisions, error resolutions, and task updates that you (or the LLM extraction) tell it to remember. These are persisted to disk as JSON files.
- **Captured command output** -- when you use the `rc` wrapper (e.g. `rc pnpm build`), stdout/stderr is temporarily captured and sent to the daemon for context. The temp file is deleted immediately after capture.
- **Passive monitoring** -- when enabled, the daemon observes tool calls made by agents (file edits, shell commands) to build richer context. This can be disabled.

## Where Data is Stored

All data stays on your machine.

| Path | Contents |
|------|----------|
| `~/.ambient/memory/` | Persistent memory -- JSON files organized by project and branch |
| `~/.ambient/config.json` | Your configuration (default agent, templates, privacy settings, LLM provider) |
| `~/.ambient/usage.json` | API usage tracking (token counts, costs) |
| `~/.ambient/daemon.log` | Daemon log file (rotated at 5 MB) |
| `~/.ambient/ignore` | Directory patterns to exclude from monitoring |
| Unix socket in `$XDG_RUNTIME_DIR` | Daemon IPC (ephemeral, deleted on shutdown) |

No cloud storage. No database. Plain JSON files you can inspect, edit, and delete at any time.

## What is Sent to External APIs

Ambient has three modes of operation with respect to API calls:

**Anthropic (default)** -- When `ANTHROPIC_API_KEY` is set and local-only mode is off, the daemon sends requests to the Anthropic API for:
- **Inline assist** -- when a command fails or you type natural language, your prompt and shell context are sent to Claude Haiku for a quick response.
- **Memory extraction** -- after an agent responds, the prompt and response are sent to Haiku to extract structured facts (decisions, errors, task updates).
- **Memory compaction** -- when events exceed thresholds, old events are sent to Haiku for summarization.

**Ollama (local)** -- When configured with `"provider": "ollama"`, all LLM calls go to a local Ollama instance on `localhost:11434`. Nothing leaves your machine.

**No API key** -- If no API key is set and no local provider is configured, the daemon still works for routing queries to agents, maintaining context, and storing memories. Only the auto-assist, extraction, and compaction features are disabled.

### What does NOT get sent

- **File contents** -- unless you explicitly pipe them (e.g. `cat file | r "explain"`)
- **Environment variables** -- never sent; known secret patterns are actively redacted
- **SSH keys, credentials, or .env files** -- commands that read these are blocked by the secret filter
- **Your full command history** -- only the current prompt and recent context are included

### Secret filtering

Ambient automatically redacts known secret patterns before any data leaves your machine:
- API key prefixes (`sk-ant-`, `sk-`, `ghp_`, `xoxb-`, etc.)
- Inline assignments (`password=`, `token=`, `API_KEY=`)
- Commands that read secret files (`cat ~/.ssh/...`) are fully blocked

## Opting Out

### Disable all API calls

```bash
ambient privacy local-only on
```

This prevents all LLM API calls. Agents still work (they have their own API keys), but auto-assist, extraction, and compaction are disabled.

### Disable passive monitoring

```bash
ambient privacy monitoring off
```

This stops the daemon from observing tool calls made by agents.

### Exclude directories

Create `~/.ambient/ignore` with one pattern per line:

```
~/work/classified/**
~/secrets
*.env
```

The daemon will not track commands or store memories when you are inside ignored directories.

### Unset the API key

```bash
unset ANTHROPIC_API_KEY
```

Without a key, no API calls can be made. The daemon will still maintain context and route to agents.

### Full removal

```bash
# Stop the daemon
ambient daemon stop

# Remove all stored data
rm -rf ~/.ambient

# Remove shell integration from your rc file
# Delete the `source .../ambient.zsh` line from ~/.zshrc (or .bashrc / config.fish)

# Unlink the CLI
pnpm unlink --global
```

## Data Retention

- **Active memory**: 90-day TTL. Events older than 90 days are cleaned up on daemon startup.
- **Archived branches**: Merged branch memories are moved to `archived/` with a 7-day TTL before deletion.
- **Command history**: In-memory only. Lost on daemon restart.
- **Usage data**: Kept for the last 30 days of daily breakdowns. All-time totals persist until manually reset.
- **Backup**: `ambient memories export` dumps all memory to JSON for manual backup. `ambient memories import <file>` restores from a backup.
