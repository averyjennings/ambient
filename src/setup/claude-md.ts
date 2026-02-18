import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const AMBIENT_MARKER_START = "<!-- ambient:memory-instructions -->"
const AMBIENT_MARKER_END = "<!-- /ambient:memory-instructions -->"

// Version bump this when the section content changes so existing installs get updated.
const AMBIENT_SECTION_VERSION = "4"
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

### Writing memories — store BEFORE moving on to the next topic or tool call:

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
- Store memories BEFORE moving on — if you just diagnosed a root cause, made an architectural choice, or resolved a non-obvious error, store it before your next action, even if the fix isn't complete yet.
- During multi-step debugging, store findings at each checkpoint (diagnosis, root cause, resolution) rather than waiting until the end.
- Read existing memories before writing to avoid duplicates.
- Do not record trivial actions (file reads, ls, etc.).
- When in doubt, store it.
${AMBIENT_MARKER_END}
`

// --- Multi-agent instruction file support ---

/**
 * Known project-level agent instruction files.
 * When these exist in a project, ambient updates them with memory instructions.
 */
const PROJECT_INSTRUCTION_FILES = [
  "CLAUDE.md",                        // Claude Code
  "AGENTS.md",                        // OpenAI Codex CLI
  "GEMINI.md",                        // Google Gemini CLI
  ".github/copilot-instructions.md",  // GitHub Copilot
  ".cursorrules",                     // Cursor
  ".windsurfrules",                   // Windsurf
  ".goosehints",                      // Goose
]

/**
 * Upsert the ambient instruction section into an existing file.
 * Uses HTML comment markers for idempotent add/update/skip.
 * Returns "added" | "updated" | "current".
 */
function upsertSection(filePath: string): "added" | "updated" | "current" {
  if (!existsSync(filePath)) {
    // Ensure parent directory exists, then create
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, AMBIENT_SECTION.trimStart())
    return "added"
  }

  const content = readFileSync(filePath, "utf-8")

  if (content.includes(AMBIENT_VERSION_MARKER)) {
    return "current" // already has the latest version
  }

  if (content.includes(AMBIENT_MARKER_START)) {
    // Outdated version — replace the section
    const startIdx = content.indexOf(AMBIENT_MARKER_START)
    const endIdx = content.indexOf(AMBIENT_MARKER_END)

    if (endIdx !== -1) {
      const endOfMarker = endIdx + AMBIENT_MARKER_END.length
      const before = content.slice(0, startIdx)
      const after = content.slice(endOfMarker)
      writeFileSync(filePath, before + AMBIENT_SECTION.trimStart() + after)
    } else {
      const before = content.slice(0, startIdx)
      writeFileSync(filePath, before + AMBIENT_SECTION.trimStart())
    }
    return "updated"
  }

  // No marker at all — append
  appendFileSync(filePath, AMBIENT_SECTION)
  return "added"
}

// --- Global instruction file (~/CLAUDE.md) ---

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
  try {
    return upsertSection(resolveGlobalClaudeMd())
  } catch {
    return "failed"
  }
}

// --- Project-level instruction files ---

export interface ProjectInstructionsResult {
  /** Files that were updated (already existed, got ambient section added/refreshed) */
  updated: string[]
  /** Files that were already current */
  current: string[]
}

/**
 * Update existing agent instruction files in a project directory with ambient instructions.
 * Only modifies files that ALREADY EXIST — never creates new ones to avoid
 * cluttering repos with files for agents the user doesn't use.
 *
 * Call this on daemon startup for the active cwd, or via `ambient setup`.
 */
export function ensureProjectInstructions(projectDir: string): ProjectInstructionsResult {
  const updated: string[] = []
  const current: string[] = []

  for (const relPath of PROJECT_INSTRUCTION_FILES) {
    const fullPath = join(projectDir, relPath)
    if (!existsSync(fullPath)) continue

    try {
      const result = upsertSection(fullPath)
      if (result === "added" || result === "updated") {
        updated.push(relPath)
      } else {
        current.push(relPath)
      }
    } catch {
      // skip files we can't write to
    }
  }

  return { updated, current }
}

/**
 * Create ambient instruction sections in specified agent instruction files.
 * Unlike ensureProjectInstructions, this CREATES files that don't exist.
 * Used by `ambient setup --agents` to initialize instruction files for chosen agents.
 */
export function initProjectInstructions(projectDir: string, agents: string[]): string[] {
  const agentToFile: Record<string, string> = {
    "claude": "CLAUDE.md",
    "codex": "AGENTS.md",
    "gemini": "GEMINI.md",
    "copilot": ".github/copilot-instructions.md",
    "cursor": ".cursorrules",
    "windsurf": ".windsurfrules",
    "goose": ".goosehints",
  }

  const created: string[] = []

  for (const agent of agents) {
    const relPath = agentToFile[agent.toLowerCase()]
    if (!relPath) continue

    const fullPath = join(projectDir, relPath)
    try {
      const result = upsertSection(fullPath)
      if (result === "added" || result === "updated") {
        created.push(relPath)
      }
    } catch {
      // skip
    }
  }

  return created
}

/** List of supported agent names for initProjectInstructions. */
export const SUPPORTED_AGENTS = ["claude", "codex", "gemini", "copilot", "cursor", "windsurf", "goose"] as const
