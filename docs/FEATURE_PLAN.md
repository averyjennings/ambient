# Ambient Feature Plan

Status of features and planned improvements.

## Completed

### Project-type detection & smart context
Detects Node, Rust, Go, Python, Make, Deno, Java, Elixir projects. Extracts scripts, package manager, framework. Auto-runs on `chpwd`.

### Stderr/output capture
`rc` wrapper captures stdout+stderr to temp file, sends to daemon. `r capture` CLI command reads stdin. Output injected into context on next query.

### Per-directory sessions
Sessions keyed by `projectKey:taskKey` (git remote + branch). Switching directories starts a new session. `r new` resets current session.

### Prompt templates / named workflows
Built-in templates: `review`, `review-staged`, `commit`, `fix`, `test`, `explain`. Custom templates via `~/.ambient/config.json`. Templates can execute shell commands and pipe output.

### Persistent memory (two-level)
Project-level memory (shared across branches) + task-level memory (per-branch). TF-IDF cross-project search, LLM-powered compaction via Haiku, branch merge lifecycle with decision promotion. 30-day TTL, 50/100 event limits with importance-based eviction.

### Agent auto-selection
Keyword-based capability matching with specialization scoring. 8 built-in agents with capability tags. `defaultAgent: "auto"` in config enables it.

### Watch mode / proactive suggestions
Detects 3+ repeated failures of same command within 5 minutes. Generates pending suggestions. Shell can check via `r suggest`.

### Multi-agent pipelines
`r compare` runs multiple agents in parallel on same query. Sequential piping works via stdin.

### MCP context injection
Full MCP server (`r mcp-serve`) with 5 resources and 12 tools. Stdio transport for Claude Code integration. Fallback to disk when daemon is down.

---

## Recently Added

### MCP tools: `get_recent_output`
Exposes captured command output to agents. Previously only available internally via `formatForPrompt()`.

### MCP tools: `search_all_memory`
Cross-project TF-IDF memory search via MCP. Previously only available in the daemon's internal query flow.

### MCP tools: `update_memory` / `delete_memory`
Agents can now correct, update, or remove memory entries. Previously memory was write-only from the agent's perspective.

### Alt+A timeout fix
Added 4-second perl alarm wrapper to prevent shell freeze if daemon hangs. Matches the timeout pattern used by `command_not_found_handler`.

### Whitelist-based auto-capture
`accept-line` widget auto-wraps known-safe commands (build tools, test runners, linters) in `rc` for automatic output capture. Uses a whitelist (not blacklist) to avoid breaking TUI apps.

---

## Planned

### Semantic deduplication
Current dedup only checks last event's first 80 chars. Need embedding-based or fuzzy matching to detect paraphrased duplicates across sessions.

### Memory importance auto-escalation
Frequently-referenced events should gain importance over time. Currently importance is static (set on write, never changes).

### Memory search via embeddings
Replace TF-IDF with vector embeddings for semantic search. Would improve recall for conceptually-related but differently-worded queries.

### Context file watching
`.ambient/context.md` is regenerated on directory change and memory writes, but not on file saves. Could use `fswatch` to detect code changes.

### Custom context providers
Plugin system for adding context sources (Linear issues, Slack threads, Notion docs).

### Better shell output capture
Explore terminal-agnostic passive capture approaches (per-command PTY, zpty). Current whitelist-based auto-capture covers common tools but misses custom commands.

### `run_shell_command` MCP tool
Let agents execute commands in the user's shell context via MCP. Requires careful sandboxing.

### Agent marketplace
Discover and install community agent configurations via `r discover`.
