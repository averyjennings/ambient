import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const AMBIENT_MARKER_START = "<!-- ambient:memory-instructions -->"
const AMBIENT_MARKER_END = "<!-- /ambient:memory-instructions -->"

// Version bump this when the section content changes so existing installs get updated.
const AMBIENT_SECTION_VERSION = "3"
const AMBIENT_VERSION_MARKER = `<!-- ambient:version:${AMBIENT_SECTION_VERSION} -->`

const AMBIENT_SECTION = `
${AMBIENT_MARKER_START}
${AMBIENT_VERSION_MARKER}
## Ambient Memory (REQUIRED)

Ambient is your persistent memory across sessions, scoped to project and git branch.

### Session start — call ALL THREE before any work:
1. \`get_task_context\` — merged project + branch memory
2. \`get_shell_context\` — cwd, git state, recent commands, project info
3. \`get_decisions\` — past architectural decisions

### Writing memories — call IMMEDIATELY, in the SAME response as the action:

| Trigger | Tool |
|---|---|
| You choose between two approaches | \`store_decision\` (include reasoning) |
| You reject or revert a previous approach | \`store_decision\` (supersedes old one) |
| You discover something surprising about the codebase | \`store_decision\` |
| You diagnose and fix a non-obvious bug | \`store_error_resolution\` |
| You start a significant chunk of work | \`store_task_update\` (status: started) |
| You finish a significant chunk of work | \`store_task_update\` (status: completed) |

### Cross-session awareness — see what other sessions/projects are doing:
- \`get_recent_activity\` — recent events across ALL projects, no query needed
- \`search_all_memory\` — search across all projects/branches by keyword

### Debugging context:
- \`get_command_history\` — recent commands with exit codes (filter to failures)
- \`get_project_info\` — detected project type, scripts, framework
- \`get_recent_output\` — last captured command output (from \`rc\` wrapper)

### Memory management — fix or remove bad memories:
- \`list_memory_events\` — browse all events with IDs
- \`update_memory\` — correct an existing memory by ID
- \`delete_memory\` — remove obsolete/wrong memories by ID

**If MCP tools are NOT available**, use the shell command instead:
- \`ambient remember "Chose JWT with refresh tokens for auth"\`
- \`ambient remember --type task-update "Implementing rate limiting"\`
- \`ambient remember --type error-resolution "Fixed CORS by adding allowed origins"\`

### Rules
- Call write tools in the SAME response as the action. Not later. Not in bulk.
- Read existing memories before writing to avoid duplicates.
- Do not record trivial actions (file reads, ls, etc.).
- When in doubt, store it.
${AMBIENT_MARKER_END}
`

/**
 * Resolve the path to the user's global CLAUDE.md.
 * Checks ~/CLAUDE.md first (common), then ~/.claude/CLAUDE.md.
 */
function resolveGlobalClaudeMd(): string {
  const home = homedir()
  const homePath = join(home, "CLAUDE.md")
  const dotClaudePath = join(home, ".claude", "CLAUDE.md")

  if (existsSync(homePath)) return homePath
  if (existsSync(dotClaudePath)) return dotClaudePath

  // Default: create in home directory
  return homePath
}

/**
 * Ensure the global CLAUDE.md has ambient memory instructions.
 * Idempotent — adds if missing, updates if outdated (version mismatch).
 * Returns "added" | "updated" | "current" | "failed".
 */
export function ensureAmbientInstructions(): "added" | "updated" | "current" | "failed" {
  const claudeMdPath = resolveGlobalClaudeMd()

  try {
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, "utf-8")

      if (content.includes(AMBIENT_VERSION_MARKER)) {
        return "current" // already has the latest version
      }

      if (content.includes(AMBIENT_MARKER_START)) {
        // Outdated version — replace the section
        const startIdx = content.indexOf(AMBIENT_MARKER_START)
        const endIdx = content.indexOf(AMBIENT_MARKER_END)

        if (endIdx !== -1) {
          // Has both markers — clean replacement
          const endOfMarker = endIdx + AMBIENT_MARKER_END.length
          const before = content.slice(0, startIdx)
          const after = content.slice(endOfMarker)
          writeFileSync(claudeMdPath, before + AMBIENT_SECTION.trimStart() + after)
        } else {
          // Old format without end marker — replace from start marker to end of file
          const before = content.slice(0, startIdx)
          writeFileSync(claudeMdPath, before + AMBIENT_SECTION.trimStart())
        }
        return "updated"
      }

      // No marker at all — append
      appendFileSync(claudeMdPath, AMBIENT_SECTION)
      return "added"
    }

    // Create new file
    writeFileSync(claudeMdPath, AMBIENT_SECTION.trimStart())
    return "added"
  } catch {
    return "failed"
  }
}
