import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const AMBIENT_MARKER = "<!-- ambient:memory-instructions -->"

const AMBIENT_SECTION = `
${AMBIENT_MARKER}
## Ambient Memory

Ambient is your persistent memory layer. It remembers decisions, tasks, and error resolutions across sessions, scoped to the current project and git branch.

### Reading context
- At the start of a session, call \`get_task_context\` (ambient MCP) to see what you remember about this project and branch.
- Use \`get_shell_context\` to see the user's current terminal state (cwd, git branch, recent commands).
- Use \`get_decisions\` to recall past architectural decisions.

### Writing memories (do this proactively)

**If ambient MCP tools are available** (look for \`store_decision\`, \`store_task_update\`, \`store_error_resolution\`):
- **\`store_decision\`**: Record important decisions (architecture, library choice, design pattern). Include brief reasoning.
- **\`store_task_update\`**: Record task starts and completions.
- **\`store_error_resolution\`**: Record errors and how they were fixed.

**If MCP tools are NOT available**, use the shell command instead:
- \`ambient remember "Chose JWT with refresh tokens for auth"\` — stores as a decision
- \`ambient remember --type task-update "Implementing rate limiting"\` — stores as task update
- \`ambient remember --type error-resolution "Fixed CORS by adding allowed origins"\` — stores error fix

### When to write
- Record decisions as you make them, not at the end of a session.
- Record task updates when starting work and when completing it.
- Record error resolutions immediately after fixing an issue.
- Do NOT record trivial actions (reading files, running ls, etc.).
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
 * Idempotent — skips if the marker is already present.
 * Returns true if instructions were added, false if already present.
 */
export function ensureAmbientInstructions(): boolean {
  const claudeMdPath = resolveGlobalClaudeMd()

  try {
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, "utf-8")
      if (content.includes(AMBIENT_MARKER)) {
        return false // already installed
      }
      // Append to existing file
      appendFileSync(claudeMdPath, AMBIENT_SECTION)
    } else {
      // Create new file with just the ambient section
      writeFileSync(claudeMdPath, AMBIENT_SECTION.trimStart())
    }
    return true
  } catch {
    // Silently fail — CLAUDE.md integration is best-effort
    return false
  }
}
