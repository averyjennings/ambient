# How Memory Works

Ambient gives every agent session access to facts from previous sessions -- decisions, error fixes, task progress -- across projects and branches.

## The Two Levels

```
~/.ambient/memory/projects/
  <project-hash>/
    project.json              <-- cross-branch (shared by all branches)
    tasks/
      main.json               <-- per-branch
      feat--auth.json          <-- "/" in branch names becomes "--"
    archived/
      old-feature.json         <-- merged branches archived here
```

### Project Memory (cross-branch)

Shared across all branches of a repository. Stores high-importance decisions that affect the whole project: framework choices, architecture patterns, database selections. Survives branch deletion and merges. The project key is derived from the git remote URL (SHA256 hash), so multiple clones of the same repo share memory.

### Task Memory (per-branch)

Scoped to the current git branch. Stores everything: decisions, error resolutions, task updates, file context, session summaries. When a branch is merged, high-importance events are promoted to project memory and the task file is archived.

## What Gets Remembered

### Automatically

- **Shell command classification** -- git checkouts, commits, merges, package installs, and build/test results are automatically recorded by the daemon
- **Agent response extraction** -- after streaming an agent's response, the daemon sends the prompt and response to the LLM to extract structured facts (decisions made, errors fixed, tasks completed)
- **Assist interactions** -- when ambient responds to natural language or failed commands, the exchange is recorded

### Manually

- `r remember "chose JWT for auth"` -- stores a decision (high importance by default)
- `r remember --type task-update "finished rate limiting"` -- stores with a specific type
- `r remember --type error-resolution --importance medium "fixed CORS by adding origins"` -- with type and importance
- MCP tools: `store_decision`, `store_task_update`, `store_error_resolution` -- used by agents like Claude Code via the MCP server

### What Does NOT Get Remembered

- File reads, `ls`, `cd`, and other navigation commands
- Passing tests and successful builds (only failures are noteworthy)
- Trivial interactions (greetings, confirmations)

## Browsing Memories

**Quick view** -- memories for the current project and branch:

```
r memory
```

**Full browsing** -- newest first, last 20 events:

```
ambient memories
```

**Filter by type:**

```
ambient memories --type decision
ambient memories --type error-resolution
ambient memories --type task-update
```

**Filter by recency:**

```
ambient memories --since 7d
ambient memories --since 24h
ambient memories --since 2025-01-01
```

**Filter by importance:**

```
ambient memories --importance high
```

**Show all events (not just last 20):**

```
ambient memories --all
```

**Search across all projects and branches:**

```
ambient memories search "authentication"
ambient memories search "database migration" --limit 10
```

Search uses TF-IDF scoring combined with recency, so recent relevant events rank highest. High-importance events get a 1.5x boost.

**Statistics:**

```
ambient memories stats
```

Shows event counts by type and importance, disk usage, and date range.

## Managing Memories

**Delete an event** (with confirmation):

```
ambient memories delete <event-id>
ambient memories delete <event-id> --force   # skip confirmation
```

Event IDs can be abbreviated -- the first 8 characters are usually enough.

**Edit an event:**

```
ambient memories edit <event-id>                    # opens in $EDITOR
ambient memories edit <event-id> --content "new text"  # inline edit
```

**Export all memory to JSON:**

```
ambient memories export > backup.json
ambient memories export --pretty > backup.json   # formatted
```

**Import from a backup:**

```
ambient memories import backup.json
```

Duplicate events (matching IDs) are skipped automatically.

## Memory Lifecycle

### Supersede Detection

When you store a new decision, ambient checks existing decisions for similarity using Jaccard keyword overlap. If an existing decision shares more than 40% of keywords with the new one, the old one is replaced. This prevents duplicate decisions from accumulating.

For example, storing "Use JWT with refresh tokens for auth" will supersede an earlier "Use session cookies for auth" because the keyword overlap (auth, use, for) exceeds the threshold.

### Compaction

When events exceed thresholds (40 project events, 80 task events), compaction runs:

1. High-importance events are protected and never compacted
2. The oldest low/medium-importance events are batched
3. The LLM summarizes them into a single `session-summary` event
4. If the LLM is unavailable, only `low`-importance events are dropped

### Branch Merge

When the daemon detects a merged branch (via `git branch --merged`):

1. High-importance decisions are promoted to project memory
2. The task file is moved to `archived/`
3. Archived files are deleted after 7 days

### TTL

- **Active events**: cleaned up after 90 days of inactivity
- **Archived branch files**: deleted 7 days after archival
- **Cleanup runs on daemon startup** and on directory changes

## Importance Levels

| Level | Stored in | Examples | Auto-compacted |
|-------|-----------|----------|----------------|
| **high** | Project + task | Architecture decisions, framework choices, database selection | Never |
| **medium** | Task only | Error fixes, config changes, dependency updates | Yes, when old |
| **low** | Task only | File context, minor updates, session summaries | Yes, first to go |

## Memory and MCP

Agents like Claude Code access memory through ambient's MCP server (12 tools, 5 resources). At session start, agents call `get_task_context`, `get_shell_context`, and `get_decisions` to load relevant context. During work, they call `store_decision`, `store_task_update`, and `store_error_resolution` to record what they learn.

The MCP server falls back to reading/writing disk directly when the daemon is down, so memory tools work regardless of daemon state.
