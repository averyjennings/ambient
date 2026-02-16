import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const REMIND_SCRIPT_NAME = "ambient-remind.sh"
const ACTIVITY_SCRIPT_NAME = "ambient-activity.sh"
const FLUSH_SCRIPT_NAME = "ambient-flush.sh"

/**
 * Content of the periodic reminder script.
 * Runs on UserPromptSubmit. Emits a reminder every 20 minutes so long-running
 * sessions and post-/clear sessions don't forget about ambient.
 */
const REMIND_SCRIPT = `#!/bin/bash
# Ambient periodic memory reminder (managed by ambient — do not edit)
# Runs on Claude Code UserPromptSubmit hook.
# Emits a reminder every 20 minutes for long sessions and after /clear.

REMIND_FILE="/tmp/claude-ambient-remind"
NOW=$(date +%s)
LAST=$(cat "$REMIND_FILE" 2>/dev/null || echo 0)
ELAPSED=$((NOW - LAST))

# Remind every 20 minutes (1200 seconds)
if [ "$ELAPSED" -gt 1200 ]; then
    echo "$NOW" > "$REMIND_FILE"
    echo "AMBIENT: If context is stale or was cleared, call get_task_context and get_decisions. Store any unmemoried decisions, error resolutions, or task completions NOW."
fi
`

const SESSION_START_ECHO = "echo 'AMBIENT: Call get_task_context, get_shell_context, AND get_decisions NOW before doing any work. Store decisions in the SAME response as the action — not later.'"

interface HookEntry {
  readonly matcher?: string
  readonly hooks: ReadonlyArray<{
    readonly type: string
    readonly command: string
    readonly async?: boolean
  }>
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

/**
 * Ensure the periodic reminder script exists at ~/.ambient/hooks/ambient-remind.sh.
 * Creates the directory and script if missing. Overwrites if content differs.
 */
function ensureRemindScript(): string {
  const hooksDir = join(homedir(), ".ambient", "hooks")
  mkdirSync(hooksDir, { recursive: true })

  const scriptPath = join(hooksDir, REMIND_SCRIPT_NAME)

  if (existsSync(scriptPath)) {
    const existing = readFileSync(scriptPath, "utf-8")
    if (existing === REMIND_SCRIPT) {
      return scriptPath // already current
    }
  }

  writeFileSync(scriptPath, REMIND_SCRIPT, { mode: 0o755 })
  return scriptPath
}

/**
 * Content of the PostToolUse hook script.
 * Captures tool activity (Edit, Write, Bash) and sends to daemon.
 * No stdout — completely invisible to Claude's context.
 */
const ACTIVITY_SCRIPT = `#!/bin/bash
# Ambient passive monitoring — PostToolUse hook (managed by ambient — do not edit)
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$TOOL" ] && exit 0
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
DESC=$(echo "$INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && exit 0
ambient notify "{\\"type\\":\\"activity\\",\\"payload\\":{\\"cwd\\":\\"$CWD\\",\\"tool\\":\\"$TOOL\\",\\"filePath\\":\\"$FILE\\",\\"command\\":\\"$(echo "$CMD" | head -c 200)\\",\\"description\\":\\"$DESC\\"}}" 2>/dev/null
exit 0
`

/**
 * Content of the Stop hook script.
 * Reads the last assistant message from the transcript for reasoning capture.
 * No stdout — completely invisible to Claude's context.
 */
const FLUSH_SCRIPT = `#!/bin/bash
# Ambient passive monitoring — Stop hook (managed by ambient — do not edit)
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && exit 0
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
REASONING=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  REASONING=$(tail -200 "$TRANSCRIPT" 2>/dev/null | grep '"type":"assistant"' | tail -1 | \\
    jq -r '[.message.content[]? | select(.type == "text") | .text] | join(" ")' 2>/dev/null | head -c 4000)
fi
REASONING_ESC=$(echo "$REASONING" | jq -Rs '.' 2>/dev/null | sed 's/^"//;s/"$//')
ambient notify "{\\"type\\":\\"activity-flush\\",\\"payload\\":{\\"cwd\\":\\"$CWD\\",\\"reasoning\\":\\"$REASONING_ESC\\"}}" 2>/dev/null
exit 0
`

/**
 * Ensure the activity hook script exists at ~/.ambient/hooks/ambient-activity.sh.
 */
function ensureActivityScript(): string {
  const hooksDir = join(homedir(), ".ambient", "hooks")
  mkdirSync(hooksDir, { recursive: true })
  const scriptPath = join(hooksDir, ACTIVITY_SCRIPT_NAME)

  if (existsSync(scriptPath)) {
    const existing = readFileSync(scriptPath, "utf-8")
    if (existing === ACTIVITY_SCRIPT) return scriptPath
  }

  writeFileSync(scriptPath, ACTIVITY_SCRIPT, { mode: 0o755 })
  return scriptPath
}

/**
 * Ensure the flush hook script exists at ~/.ambient/hooks/ambient-flush.sh.
 */
function ensureFlushScript(): string {
  const hooksDir = join(homedir(), ".ambient", "hooks")
  mkdirSync(hooksDir, { recursive: true })
  const scriptPath = join(hooksDir, FLUSH_SCRIPT_NAME)

  if (existsSync(scriptPath)) {
    const existing = readFileSync(scriptPath, "utf-8")
    if (existing === FLUSH_SCRIPT) return scriptPath
  }

  writeFileSync(scriptPath, FLUSH_SCRIPT, { mode: 0o755 })
  return scriptPath
}

/**
 * Check if a hook command already exists in an array of hook entries.
 */
function hasHookCommand(entries: readonly HookEntry[], command: string): boolean {
  return entries.some(entry =>
    entry.hooks.some(h => h.command === command),
  )
}

/**
 * Ensure Claude Code's global settings.json has ambient hooks registered.
 * Adds:
 *   - SessionStart: echo reminder to call ambient tools
 *   - UserPromptSubmit: periodic reminder script (every 20 min)
 *   - PostToolUse: passive activity monitoring (Edit, Write, Bash)
 *   - Stop: flush activity buffer + capture reasoning from transcript
 *
 * Idempotent — checks for existing hooks by command string.
 * Returns { added: string[], skipped: string[] }.
 */
export function ensureClaudeHooks(): { added: string[]; skipped: string[] } {
  const added: string[] = []
  const skipped: string[] = []

  const settingsPath = join(homedir(), ".claude", "settings.json")

  try {
    const remindScriptPath = ensureRemindScript()
    const activityScriptPath = ensureActivityScript()
    const flushScriptPath = ensureFlushScript()

    // Load or create settings
    let settings: ClaudeSettings = {}
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings
    } else {
      // Create ~/.claude/ if needed
      mkdirSync(join(homedir(), ".claude"), { recursive: true })
    }

    if (!settings.hooks) {
      settings.hooks = {}
    }

    // --- SessionStart: echo reminder ---
    if (!settings.hooks["SessionStart"]) {
      settings.hooks["SessionStart"] = []
    }
    if (hasHookCommand(settings.hooks["SessionStart"], SESSION_START_ECHO)) {
      skipped.push("SessionStart")
    } else {
      settings.hooks["SessionStart"].push({
        hooks: [{ type: "command", command: SESSION_START_ECHO }],
      })
      added.push("SessionStart")
    }

    // --- UserPromptSubmit: periodic reminder ---
    if (!settings.hooks["UserPromptSubmit"]) {
      settings.hooks["UserPromptSubmit"] = []
    }
    if (hasHookCommand(settings.hooks["UserPromptSubmit"], remindScriptPath)) {
      skipped.push("UserPromptSubmit")
    } else {
      settings.hooks["UserPromptSubmit"].push({
        hooks: [{ type: "command", command: remindScriptPath }],
      })
      added.push("UserPromptSubmit")
    }

    // --- PostToolUse: passive activity monitoring ---
    if (!settings.hooks["PostToolUse"]) {
      settings.hooks["PostToolUse"] = []
    }
    if (hasHookCommand(settings.hooks["PostToolUse"], activityScriptPath)) {
      skipped.push("PostToolUse")
    } else {
      settings.hooks["PostToolUse"].push({
        matcher: "Edit|Write|Bash",
        hooks: [{ type: "command", command: activityScriptPath, async: true }],
      })
      added.push("PostToolUse")
    }

    // --- Stop: flush activity buffer + capture transcript reasoning ---
    if (!settings.hooks["Stop"]) {
      settings.hooks["Stop"] = []
    }
    if (hasHookCommand(settings.hooks["Stop"], flushScriptPath)) {
      skipped.push("Stop")
    } else {
      settings.hooks["Stop"].push({
        hooks: [{ type: "command", command: flushScriptPath, async: true }],
      })
      added.push("Stop")
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
    return { added, skipped }
  } catch {
    return { added: [], skipped: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] }
  }
}
