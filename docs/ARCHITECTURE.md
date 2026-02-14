# Ambient Architecture

Ambient is a **context layer for coding agents**. It's not an AI agent itself — it's infrastructure that makes *every* coding agent smarter by giving them persistent memory, shell awareness, and terminal context. You type `r "fix this"` in your terminal and the right agent gets called with everything it needs to know about your project, your recent commands, what broke, and what you decided last week.

## The Core Insight

Coding agents like Claude Code, Codex, and Gemini CLI all share the same problem: every invocation starts from zero. They don't know what you just ran, what failed, what branch you're on, or what you decided yesterday. Ambient fixes this by sitting between your shell and your agents, maintaining a persistent understanding of your work.

Ambient follows the **sidecar pattern** — it doesn't modify your shell or wrap your terminal. Instead, it uses standard zsh hooks (preexec/precmd/chpwd) to passively observe your activity, then injects that context into agent prompts when you ask a question. This is why the shell integration is only ~325 lines and can't break your existing setup.

---

## The Three Processes

Ambient has exactly three runtime entry points, all from the same binary (`dist/cli/index.js`):

### 1. The CLI (`r` command) — `src/cli/index.ts`

A **thin client** that talks to the daemon over a Unix socket. When you type `r "why is my build failing"`, the CLI:

1. Checks if the daemon is alive (reads PID file, sends `kill(pid, 0)`)
2. Auto-starts the daemon if it's not running (spawns detached, waits up to 5s for socket)
3. Sends a JSON request over the socket
4. Streams the response back to your terminal (chunk by chunk, so you see output immediately)
5. Exits

The CLI also handles subcommands without going through the daemon's query flow: `r daemon start/stop/status`, `r mcp-serve`, `r setup`, `r remember`, `r memory`, `r agents`, `r compare`, `r templates`, `r capture`, `r notify`, `r suggest`, `r assist`.

**Template system**: The first word of your query is checked against templates defined in `~/.ambient/config.json`. Built-in templates include `review` (runs `git diff` and asks for a review), `commit` (runs `git diff --cached` and generates a message), `fix`, `test`, `explain`. If a template has a `command` field, that command's output is piped as context.

### 2. The Daemon — `src/daemon/index.ts`

A **persistent background process** listening on `$XDG_RUNTIME_DIR/ambient-<uid>.sock`. This is the brain of the system. It:

- Maintains the **ContextEngine** singleton — knows your cwd, git branch, last 50 commands, exit codes, project type
- Manages **per-branch sessions** — keyed by `projectKey:taskKey`, so switching branches gives you a fresh conversation
- Routes queries to agents via the **AgentRouter** — spawns subprocesses, streams output back
- Runs **auto-assist** — when a command fails (or you type natural language), it streams a Haiku response explaining what went wrong
- **Extracts memories** from agent responses — after streaming a response to you, it asynchronously calls Haiku to extract structured facts (decisions, error resolutions, task updates) and stores them
- **Classifies shell commands** — git commits, package installs, build failures, test results are automatically recorded as memory events
- **Auto-shuts down** after 24h of inactivity to prevent zombie processes

On startup, the daemon also:
- Detects which agents are installed (runs `which` for each)
- Injects ambient's memory instructions into `~/.claude/CLAUDE.md` (versioned, idempotent)
- Registers Claude Code hooks for session reminders
- Migrates legacy memory files
- Cleans up stale memory (30-day TTL)

The daemon uses a clever **session continuity** design. For agents that support it (Claude Code with `--continue`, OpenCode with `-c`), it appends continuation args on follow-up queries. For agents that don't support native continuation, it injects the last response (truncated to 2000 chars) as "pseudo-memory" in the prompt. This means `r "now refactor that"` works regardless of which agent you're using — the daemon remembers what "that" refers to.

### 3. The MCP Server — `src/mcp/server.ts`

Runs via `r mcp-serve` on **stdio transport**. This is how agents like Claude Code access ambient's context *from the inside*. Instead of ambient wrapping the agent, the agent calls ambient's tools directly.

**5 Resources** (read-only data):
- `ambient://context` — live shell context JSON
- `ambient://history` — command history
- `ambient://project` — project type/scripts/framework
- `ambient://memory/project` — project-level memory
- `ambient://memory/task` — task/branch-level memory

**12 Tools** (actions):
- Read: `get_shell_context`, `get_command_history`, `get_project_info`, `get_task_context`, `get_decisions`, `get_recent_output`, `search_all_memory`, `list_memory_events`
- Write: `store_decision`, `store_task_update`, `store_error_resolution`, `update_memory`, `delete_memory`

Every tool tries the daemon first via IPC (`sendDaemonRequest`), then falls back to reading/writing disk directly. This means memory tools work even when the daemon is down.

The MCP server uses the official `@modelcontextprotocol/sdk` with Zod schema validation for all tool inputs. It's registered in `~/.claude.json` as an MCP server with command `node /path/to/ambient/dist/cli/index.js mcp-serve`.

---

## The Shell Integration — `shell/ambient.zsh`

325 lines of zsh, sourced from `.zshrc`. Does five things:

### 1. Three passive hooks (registered via `add-zsh-hook`)

- `preexec` — fires when you press Enter, before the command runs. Sends the command text to the daemon.
- `precmd` — fires after the command finishes. Sends exit code, refreshes git state, sends it all to the daemon.
- `chpwd` — fires on directory change. Sends new cwd + git state.

All hook communication is **fire-and-forget**: `(r notify '...' &>/dev/null &)` — a background subshell that never blocks your prompt.

### 2. Natural language interception (`_ambient_accept_line` ZLE widget)

Overrides zsh's `accept-line` to catch natural language *before* zsh tries to parse it. Detects:
- Unmatched apostrophes that look like contractions ("what's", "don't")
- Question marks in multi-word input
- Conversational starters ("what", "how", "why", "hey", "yo", etc.) — but only if the first word isn't a user-defined alias or function

When detected, it routes to `r assist` instead of letting zsh try to execute it. This is what lets you type `what does this project do` in your terminal and get an answer instead of `zsh: command not found: what`.

### 3. `command_not_found_handler`

Zsh's built-in hook for when a command doesn't exist. Ambient overrides it to call `r assist "$*" 127` with a 4-second perl alarm timeout, showing the response as `ambient → ...`.

### 4. Auto-capture (`_ambient_should_autocapture`)

A whitelist of non-interactive build tools (pnpm, npm, cargo, pytest, make, tsc, etc.). When you run a whitelisted command, the ZLE widget rewrites `pnpm build` to `rc pnpm build` before execution. The `rc` function runs the command through `tee` to capture output, then sends it to the daemon via `r capture`. This means the next time you ask "why did the build fail", ambient has the error output.

### 5. Alt+A widget (`_ambient_ai_suggest`)

Type a natural language description in the command buffer, press Alt+A, and it calls the daemon to convert it to a shell command. Shows "thinking..." while waiting, with a 4-second timeout.

The natural language detection is intentionally conservative — it only catches patterns that would *definitely* fail as shell commands. It checks `whence -w "$first_word"` to see if the word is a user alias or function. If you have an alias called `show`, typing `show files` runs your alias, not ambient.

---

## The Memory System

This is the most sophisticated part of ambient. It gives every agent session access to facts from previous sessions — decisions, errors, task progress — across projects and branches.

### Two-Level Hierarchy

```
~/.ambient/memory/projects/
  <sha256-hash>/           <- project key (from git remote URL)
    project.json           <- cross-branch memory (shared by all branches)
    tasks/
      main.json            <- branch-specific memory
      feat--auth.json      <- "/" in branch names becomes "--"
    archived/
      old-branch.json      <- merged branches get archived here
```

**Project key** (`src/memory/resolve.ts`): SHA256 of the git remote URL (so clones in different paths share memory), falling back to git root path, then cwd for non-git dirs. Truncated to 16 hex chars.

**Task key**: Sanitized branch name (`/` -> `--`, unsafe chars stripped, max 100 chars).

### Event Types

Every memory is a `MemoryEvent` with:
- `id` — UUID
- `type` — `decision` | `error-resolution` | `task-update` | `file-context` | `session-summary`
- `timestamp` — unix millis
- `content` — max 500 chars
- `importance` — `low` | `medium` | `high`
- `metadata` — optional key-value pairs

**Routing rule**: High-importance events go to *both* project and task stores. Medium/low go to task only. This means project-level decisions survive branch deletion.

### How Memories Get Created

1. **Explicit**: `r remember "chose JWT for auth"` or MCP tools (`store_decision`, `store_task_update`, `store_error_resolution`)
2. **Auto-classified shell commands** (`classifyCommand` in daemon): git checkout, commits, merges, package installs, build/test results — all automatically recorded
3. **LLM extraction** (`extractAndStoreMemories` in daemon): After streaming an agent response, Haiku reads the prompt + response and extracts structured facts as JSON-lines. Each fact becomes a separate memory event.
4. **Assist interactions**: When ambient responds to natural language or failed commands, the exchange is recorded as a `session-summary` or `error-resolution`

### Supersede Detection

When storing a new `decision` event, ambient checks existing decisions using **Jaccard similarity** on keyword sets. If an existing decision shares >40% of keywords with the new one, the old one is replaced. This prevents duplicate/evolved decisions from piling up (e.g., "Use JWT for auth" supersedes "Use session cookies for auth").

Keywords are extracted by lowercasing, removing non-alphanumeric chars, filtering words <3 chars, and removing stop words.

### TF-IDF Search

`searchAllMemory` searches across *all* projects and branches:
1. Collects every event from every project/task file
2. Extracts keywords from the query
3. Computes IDF (inverse document frequency) for each keyword across the corpus
4. Scores each event: `0.5 * recency + 0.5 * normalized_tfidf` (or pure recency if no keywords)
5. Boosts high-importance events by 1.5x
6. Returns top N results, grouped by source and sorted chronologically within groups

Recency uses exponential decay: `1 / (1 + hoursAgo / 24)` — events from today score ~1.0, 24h ago ~0.5, a week ago ~0.01.

### Compaction

When events exceed thresholds (40 project, 80 task), compaction kicks in:
1. Separate high-importance events (protected, never compacted)
2. Take the oldest N non-high events
3. Send them to Haiku with "summarize into a concise paragraph"
4. Replace the batch with a single `session-summary` event
5. If Haiku fails, fallback: just drop the oldest `low`-importance events

### Lifecycle Management (`src/memory/lifecycle.ts`)

On directory change, the daemon runs `processMergedBranches`:
1. `git branch --merged` lists branches merged into the current branch
2. For each merged branch with stored memory: promote high-importance decisions to project-level, then archive the task file
3. Archived files go to `archived/` and have `archived: true`
4. Stale files (>30 days) are deleted entirely

The memory system uses **append-only events with periodic compaction** rather than a mutable document. This mirrors event sourcing patterns — you never lose history, just summarize it. The compaction is graceful: if the Haiku API is unavailable, it degrades to dropping `low`-importance events only. High-importance decisions are never deleted automatically.

---

## The Agent Router — `src/agents/router.ts`

Routes prompts to any of 8 built-in agents by spawning their CLI as a subprocess:

| Agent | Command | Session Support | Priority |
|-------|---------|----------------|----------|
| Claude Code | `claude -p` | `--continue` | 10 |
| Codex | `codex exec` | — | 8 |
| Gemini | `gemini -p` | — | 7 |
| Goose | `goose run --no-session -t` | — | 6 |
| Aider | `aider --message` | — | 5 |
| Copilot | `copilot -p` | — | 5 |
| OpenCode | `opencode run` | `-c` | 5 |
| gptme | `gptme --non-interactive` | — | 4 |

The router:
1. Builds an **enriched prompt**: `[Ambient Shell Context] + context block + [Storing memories] instructions + [Task] user prompt`
2. For continuing sessions with native support, skips context injection (the agent has conversation history)
3. Spawns via `spawnWithPty` (strips PTY artifacts from output)
4. Streams stdout/stderr as `chunk` responses back to the caller
5. Returns the full response text for session caching

**Auto-selection** (`src/agents/selector.ts`): If `defaultAgent: "auto"` in config, the selector matches query keywords against agent capability tags and picks the highest-priority match.

---

## The Fast LLM Path — `src/assist/fast-llm.ts`

For inline assist (the instant responses when you type natural language or a command fails), ambient bypasses the agent subprocess entirely and calls the **Anthropic API directly** using `fetch()`:

- Model: `claude-haiku-4-5-20251001` (fastest Claude model)
- Streaming: SSE with first tokens in ~200-300ms
- Max tokens: 200 for assist, 500 for compaction
- Timeout: 10s (streaming), 15s (non-streaming)
- Requires `ANTHROPIC_API_KEY` in environment

This is used for three things:
1. **Auto-assist** — real-time help when commands fail or you type natural language
2. **Memory extraction** — extracting structured facts from agent responses (non-streaming `callFastLlm`)
3. **Memory compaction** — summarizing old events into concise paragraphs

---

## The Setup System — `src/setup/`

Two files that make ambient integrate with Claude Code:

**`claude-md.ts`**: Injects a versioned `<!-- ambient:memory-instructions -->` section into `~/.claude/CLAUDE.md`. Contains the full protocol: which tools to call at session start, when to store decisions/errors/task updates, the available tools, and rules (call in same response, read before writing, don't record trivial actions). Checks version markers and updates if the embedded version is newer.

**`claude-hooks.ts`**: Registers hooks in Claude Code's settings (`~/.claude/settings.json`):
- `SessionStart` hook: reminds Claude to call `get_task_context`, `get_shell_context`, and `get_decisions` before doing any work
- Runs on every Claude Code session start

---

## The IPC Protocol

All communication between CLI, Daemon, and MCP uses **newline-delimited JSON** over a Unix socket:

**Request**: `{ "type": "<message-type>", "payload": { ... } }\n`

18 message types: `query`, `context-update`, `ping`, `shutdown`, `status`, `new-session`, `agents`, `capture`, `suggest`, `compare`, `assist`, `memory-store`, `memory-read`, `memory-delete`, `memory-update`, `memory-search`, `output-read`, `context-read`

**Response**: Multiple messages, always ending with `done`:
```json
{"type":"chunk","data":"Here's what happened..."}
{"type":"chunk","data":" the build failed because..."}
{"type":"done","data":""}
```

Response types: `chunk` (streamed text), `done` (terminal), `error` (error text), `status` (structured data).

---

## Config — `src/config.ts`

Lives at `~/.ambient/config.json`:
```json
{
  "defaultAgent": "claude",
  "logLevel": "info",
  "templates": {
    "review": { "command": "git diff", "prompt": "Review these changes..." },
    "commit": { "command": "git diff --cached", "prompt": "Generate commit message..." }
  }
}
```

Socket path: `$XDG_RUNTIME_DIR/ambient-<uid>.sock` (or `/tmp/ambient-<uid>.sock`)
PID file: `$XDG_RUNTIME_DIR/ambient-<uid>.pid`

---

## End-to-End Lifecycle

The lifecycle of a typical interaction:

1. You open a terminal tab -> `ambient.zsh` sources, sends `chpwd` to daemon
2. You run `pnpm build` -> ZLE widget sees it's whitelisted, rewrites to `rc pnpm build`
3. `rc` runs the command with `tee`, captures output, sends to daemon via `r capture`
4. Build fails -> `precmd` hook sends exit code to daemon, daemon records "Build failed" as memory
5. You type `why did it fail` -> ZLE detects natural language (starts with "why"), routes to `r assist`
6. Daemon builds prompt with shell context + captured output + memory, streams Haiku response
7. You see `ambient -> The build failed because of a type error in auth.ts:42...`
8. You run `r "fix the type error"` -> CLI sends query to daemon
9. Daemon injects shell context + memory (including the build failure + captured output), spawns `claude -p`
10. Claude Code sees the full context, fixes the error, response streams back
11. Daemon asynchronously calls Haiku to extract memories from Claude's response
12. You switch branches -> `chpwd` fires, daemon checks for merged branches, archives old task memory
13. Next Claude Code session starts -> MCP tools fire, Claude Code gets `get_task_context` showing the fix

That's ambient. ~5,100 lines of TypeScript + 325 lines of zsh, two runtime dependencies (`@modelcontextprotocol/sdk` and `zod`), no database, no bundler, just `tsc` and a Unix socket.
