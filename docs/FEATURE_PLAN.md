# Ambient Feature Plan

This document outlines planned features for ambient, organized by implementation priority and expected impact.

## Tier 1 — High impact, builds on existing scaffolding

### 1. Project-type detection & smart context

**Status:** Stubbed but unimplemented — `projectType` field exists in `ShellContext`, gets reset on `chpwd`, but nothing populates it.

**Problem:** When a user runs `r "why are tests failing"`, the agent gets cwd, git branch, and last exit code — but doesn't know this is a Node project, what test runner is configured, or what scripts are available. The agent is missing the most actionable context.

**Solution:** On `chpwd` (and initial startup), detect project type by checking for marker files and inject relevant metadata into the context block.

**Detection markers:**

| Marker file | Project type | Extra context to extract |
|---|---|---|
| `package.json` | node | `scripts` keys, package manager (pnpm/npm/yarn lockfile), framework |
| `Cargo.toml` | rust | workspace members, edition |
| `go.mod` | go | module name |
| `pyproject.toml` | python | build system, scripts |
| `Makefile` | make | target names |
| `deno.json` | deno | tasks |
| `build.gradle` / `pom.xml` | java | — |
| `mix.exs` | elixir | — |

**Context output example:**
```
Working directory: /Users/avery/work/ambient
Git branch: main (dirty)
Project: node (pnpm) — scripts: build, dev, lint, typecheck, test
Last command: `pnpm build` → failed (exit 2)
```

**Implementation notes:**
- Add a `detectProjectType()` method to `ContextEngine`
- Call it on `chpwd` events and on daemon startup
- Read `package.json` scripts, `Makefile` targets, etc. synchronously (fast, local files)
- Add `projectScripts` or `availableCommands` to the formatted context
- Keep detection fast — only check `existsSync` on known marker files, don't walk the tree

**Files to change:**
- `src/context/engine.ts` — add detection logic and format output
- `src/types/index.ts` — optionally expand `ShellContext` with `projectScripts`

---

### 2. Stderr/output capture on failure

**Status:** Not implemented. The context engine knows exit codes but not error messages.

**Problem:** When a command fails and the user asks `r "fix this"`, the agent knows something failed but not *what* the error was. The user has to manually copy-paste the error, which defeats the purpose of ambient context.

**Solution:** Capture the last N lines of command output when exit code != 0, and inject the error text into the context block.

**Approach — temp file capture via shell hooks:**

```zsh
# In preexec, set up output capture to a temp file
_ambient_preexec() {
  _AMBIENT_CAPTURE_FILE=$(mktemp /tmp/ambient-capture.XXXXXX)
}

# The actual command runs normally — no wrapping needed.
# Instead, capture is done via TEEOUT or process substitution.
```

Since wrapping every command would be too invasive, a more pragmatic approach:

1. **Option A (simple):** After a failed command, the `precmd` hook reads the last N lines from the terminal scrollback. This is terminal-dependent and fragile.

2. **Option B (recommended):** Add an `r capture` command that the user can pipe to:
   ```bash
   pnpm build 2>&1 | r capture
   # or via shell alias:
   alias rc='2>&1 | r capture'
   pnpm build rc
   ```
   The daemon stores the captured output and injects it on the next query.

3. **Option C (zsh-native):** Use zsh's `script` command or `REPORTTIME` hook. Most portable option is storing the last command's output via a precmd function that reads from a named pipe or temp file.

**Recommended implementation (Option B + lightweight C):**
- Add `r capture` subcommand that reads stdin and stores in daemon as `lastOutput`
- In the shell hook, after a non-zero exit code, try to read `/tmp/ambient-last-output` if it exists
- Provide a zsh function wrapper: `rc() { "$@" 2>&1 | tee /tmp/ambient-last-output; }`
- Inject stored output (truncated to ~2000 chars) into context on next query

**Context output example:**
```
Last command: `pnpm build` → failed (exit 2)
Error output (last 20 lines):
  src/daemon/index.ts(42,5): error TS2345: Argument of type 'string' is
  not assignable to parameter of type 'number'.
  Found 1 error in src/daemon/index.ts:42
```

**Files to change:**
- `src/cli/index.ts` — add `capture` subcommand
- `src/daemon/index.ts` — handle `capture` message type, store output
- `src/context/engine.ts` — add `lastOutput` field and format it
- `src/types/index.ts` — add `lastOutput` to `ShellContext`, new IPC message type
- `shell/ambient.zsh` — add `rc()` helper function

---

### 3. Per-directory sessions

**Status:** Not implemented. Single `SessionState` for the entire daemon.

**Problem:** If you're working on two projects and switch between them, your conversation session carries over incorrectly. Asking a follow-up in project B continues the session from project A.

**Solution:** Key sessions by git root (or cwd if not in a git repo). When the user sends a query, resolve the session for that directory.

**Implementation:**
- Replace `session: SessionState | null` with `sessions: Map<string, SessionState>`
- On each query, resolve the session key: `git rev-parse --show-toplevel` (cached), falling back to cwd
- `r new` resets only the current directory's session
- Idle sessions are cleaned up after a configurable timeout (default: 1 hour)

**Session key resolution:**
```typescript
function getSessionKey(cwd: string): string {
  // Prefer git root so sessions persist across subdirectories
  return gitRootCache.get(cwd) ?? cwd
}
```

**Files to change:**
- `src/daemon/index.ts` — replace single session with session map
- `src/types/index.ts` — no changes needed (SessionState shape stays the same)

---

## Tier 2 — Medium effort, high differentiation

### 4. Prompt templates / named workflows

**Status:** Not implemented. No concept of templates or shortcuts.

**Problem:** Users repeat the same patterns constantly: "review this diff", "explain the last error", "write tests for X". These require boilerplate prompts and piping.

**Solution:** Named templates in config that expand to full prompts with optional shell command piping.

**Config format:**
```json
{
  "templates": {
    "review": {
      "command": "git diff",
      "prompt": "Review these changes. Focus on bugs, security issues, and code quality."
    },
    "fix": {
      "prompt": "Fix the error from the last failed command. Show me the corrected code."
    },
    "test": {
      "prompt": "Write tests for the specified files using the project's test framework and conventions."
    },
    "explain": {
      "prompt": "Explain what this code does, focusing on the key design decisions and any potential issues."
    },
    "commit": {
      "command": "git diff --cached",
      "prompt": "Write a concise commit message for these staged changes. Output only the commit message, nothing else."
    }
  }
}
```

**Usage:**
```bash
r review                    # → git diff | r "Review these changes..."
r fix                       # → r "Fix the error from the last failed command..."
r test src/auth.ts          # → r "Write tests for src/auth.ts..."
r commit                    # → git diff --cached | r "Write a commit message..."
r explain src/daemon.ts     # → cat src/daemon.ts | r "Explain what this code does..."
```

**Implementation:**
- Templates are resolved in the CLI before sending to the daemon
- If a template has a `command`, execute it and pipe the output as `pipeInput`
- Extra args after the template name are appended to the prompt
- User templates in `~/.ambient/config.json` merge with built-in defaults
- `r templates` lists available templates

**Built-in defaults:** `review`, `fix`, `test`, `explain`, `commit` (can be overridden by user config).

**Files to change:**
- `src/cli/index.ts` — template resolution before sending query
- `src/config.ts` — template loading and merging with defaults
- `src/types/index.ts` — `TemplateConfig` type

---

### 5. Persistent memory (per-directory)

**Status:** Not implemented. Sessions live only in daemon memory.

**Problem:** When the daemon restarts (or after the 24h idle timeout), all conversation context is lost. You have to re-explain what you're working on.

**Solution:** Persist a lightweight summary per project directory. Not full conversation logs — just enough context for the agent to pick up where you left off.

**Storage format:**
```
~/.ambient/memory/
  <dir-hash>.json     # one file per project directory
```

**Memory file structure:**
```json
{
  "directory": "/Users/avery/work/ambient",
  "lastAgent": "claude",
  "lastActive": 1707500000,
  "summary": "Working on adding multi-turn conversation support. Last discussed the context injection strategy for agents without native continuation.",
  "facts": [
    "Project uses pnpm and TypeScript",
    "Daemon listens on Unix socket",
    "Claude Code is the default agent"
  ]
}
```

**How summaries are generated:**
- At session end (or every N queries), ask the current agent: "Summarize this conversation in 2-3 sentences, focusing on what was decided and what's in progress."
- Store the summary + key facts
- On next session start in the same directory, inject the memory as context:
  ```
  [Previous session context]
  Last session (2 hours ago): Working on adding multi-turn conversation support...
  ```

**Implementation:**
- Memory is read on session start and injected as part of context
- Memory is written on session end (`r new`, daemon shutdown, or idle timeout)
- Summary generation is optional — if the agent doesn't produce one, store the last query + response truncated
- Directory is hashed (SHA-256 of absolute path) for the filename

**Files to change:**
- New file: `src/memory/store.ts` — read/write memory files
- `src/daemon/index.ts` — load memory on session start, save on session end
- `src/context/engine.ts` — include memory in formatted context

---

### 6. Agent auto-selection

**Status:** Not implemented. User must manually specify `-a <agent>` or use the default.

**Problem:** Different agents have different strengths. Claude Code is great for complex reasoning, Codex for code edits, Gemini for quick answers. The user has to know which to pick.

**Solution:** Add capability tags to agent configs and match them against query intent.

**Agent capabilities:**
```typescript
interface AgentConfig {
  // ... existing fields ...
  capabilities?: readonly string[]  // e.g. ["code-edit", "reasoning", "fast", "web-search"]
  priority?: number                 // preference when multiple agents match
}
```

**Selection heuristics:**
| Query signal | Preferred capability | Example |
|---|---|---|
| "fix", "edit", "refactor", "change" | `code-edit` | `r "fix the auth bug"` |
| "explain", "why", "what does" | `reasoning` | `r "why is this failing"` |
| "quick", short query (<10 words) | `fast` | `r "what's my node version"` |
| Pipe input present | `code-review` | `git diff \| r "review"` |

**Implementation:**
- Add `capabilities` and `priority` to `AgentConfig`
- Add `selectAgent(query, context)` function that scores agents based on keyword matching
- Only select from installed agents (already detected at startup)
- User can always override with `-a`
- Default agent is used as fallback when no strong signal

**Files to change:**
- `src/types/index.ts` — add `capabilities` to `AgentConfig`
- `src/agents/registry.ts` — add capability tags to built-in agents
- New file: `src/agents/selector.ts` — selection logic
- `src/daemon/index.ts` — use selector when no agent specified

---

## Tier 3 — Higher effort, strong differentiation

### 7. Watch mode / proactive suggestions

**Status:** Not implemented. Ambient is purely reactive.

**Problem:** Users often repeat failing commands multiple times before asking for help. Ambient sees this pattern but stays silent.

**Solution:** When the daemon detects repeated failures of similar commands, proactively suggest help via the shell prompt.

**Detection rules:**
- Same command (or similar prefix) fails N times in M minutes (default: 3 failures in 5 minutes)
- A build/test command fails and the user hasn't queried ambient about it

**Notification mechanism:**
- The daemon maintains a "pending suggestion" state
- On the next `precmd` hook, the shell checks for suggestions via a fast `r suggest --check` call
- If a suggestion is pending, display it inline:
  ```
  💡 ambient: `pnpm build` has failed 3 times. Run `r fix` to investigate.
  ```

**Implementation:**
- Add failure pattern tracking to `ContextEngine`
- Add `suggest` IPC message type
- Add `_ambient_suggest_check()` to the `precmd` hook (must be fast — <50ms)
- Suggestions are dismissable and rate-limited (max 1 per 5 minutes)
- Configurable: can be disabled in config

**Files to change:**
- `src/context/engine.ts` — add failure pattern detection
- `src/daemon/index.ts` — handle `suggest` message type
- `src/cli/index.ts` — add `suggest` subcommand
- `src/types/index.ts` — add suggestion types
- `shell/ambient.zsh` — add suggestion check to `precmd`

---

### 8. Multi-agent pipelines

**Status:** Partially supported — pipe input works, but agents can't be explicitly chained.

**Problem:** Complex tasks benefit from multiple perspectives or sequential agent processing. Today, piping `r` output into another `r` works but loses agent identity and session context.

**Solution:** First-class support for chaining agents.

**Usage:**
```bash
# Sequential pipeline
r -a gemini "analyze the architecture" | r -a claude "refactor based on this analysis"

# Parallel comparison (new feature)
r compare "explain the auth flow"
# → runs claude and gemini in parallel, shows both responses side-by-side
```

**Implementation:**
- Pipe input already works via `readStdin()` — sequential pipelines work today
- Add `r compare` command that runs the same prompt through multiple agents in parallel
- Display results with agent name headers
- Optionally add a `-a agent1,agent2` syntax for explicit multi-agent queries

**Files to change:**
- `src/cli/index.ts` — add `compare` subcommand, parse comma-separated agents
- `src/daemon/index.ts` — handle parallel agent routing
- `src/agents/router.ts` — support concurrent agent spawns

---

### 9. MCP context injection

**Status:** `contextInjection: "mcp"` exists as a type value but is not implemented.

**Problem:** Prompt-prefix injection is lossy and takes up context window space. Agents that support MCP (Model Context Protocol) could get richer, structured context through a proper tool interface.

**Solution:** Run a lightweight MCP server within the ambient daemon that exposes shell context as MCP resources/tools.

**MCP resources exposed:**
| Resource | Description |
|---|---|
| `ambient://context` | Current shell context (cwd, git, commands) |
| `ambient://history` | Recent command history with exit codes |
| `ambient://project` | Project type, scripts, structure |
| `ambient://memory` | Persistent memory for current directory |
| `ambient://output` | Last captured command output |

**MCP tools exposed:**
| Tool | Description |
|---|---|
| `get_shell_context` | Returns full shell context as structured JSON |
| `get_command_history` | Returns recent commands with filters |
| `run_shell_command` | Execute a command in the user's shell context |

**Implementation:**
- Add MCP server capability to the daemon (stdio or SSE transport)
- For agents with `contextInjection: "mcp"`, start the MCP server and pass the connection to the agent
- Fall back to prompt-prefix for agents that don't support MCP
- Use the `@modelcontextprotocol/sdk` package

**Files to change:**
- New file: `src/mcp/server.ts` — MCP server implementation
- `src/agents/router.ts` — MCP-aware agent spawning
- `src/daemon/index.ts` — MCP server lifecycle management
- `package.json` — add `@modelcontextprotocol/sdk` dependency

---

## Implementation Order

Recommended order based on dependencies and incremental value:

1. **Project-type detection** (#1) — zero dependencies, immediate context improvement
2. **Per-directory sessions** (#3) — small daemon change, fixes a real usability bug
3. **Stderr capture** (#2) — needs shell hook changes + daemon support
4. **Prompt templates** (#4) — CLI-only, no daemon changes needed
5. **Persistent memory** (#5) — builds on per-directory sessions (#3)
6. **Agent auto-selection** (#6) — builds on registry capabilities
7. **Watch mode** (#7) — builds on failure tracking in context engine
8. **Multi-agent pipelines** (#8) — builds on existing pipe support
9. **MCP context injection** (#9) — largest scope, adds a dependency
