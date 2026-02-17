import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface InstallResult {
  shell: string
  rcFile: string
  status: "installed" | "already-present" | "skipped" | "failed"
}

const START_MARKER = "# --- ambient shell integration ---"
const END_MARKER = "# --- /ambient ---"

/**
 * Install ambient shell hooks into an rc file.
 * Idempotent: checks for existing markers before adding.
 */
export function installShellHooks(rcFile: string, scriptPath: string): InstallResult {
  const shell = shellFromPath(scriptPath)

  try {
    // Ensure parent directory exists (e.g. ~/.config/fish/)
    const dir = dirname(rcFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Read existing content or start empty
    let content = ""
    if (existsSync(rcFile)) {
      content = readFileSync(rcFile, "utf-8")
    }

    // Check if already installed
    if (content.includes(START_MARKER)) {
      return { shell, rcFile, status: "already-present" }
    }

    // Build the source block
    const sourceBlock = buildSourceBlock(shell, scriptPath)

    // Append to the file
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : ""
    writeFileSync(rcFile, content + separator + sourceBlock)

    return { shell, rcFile, status: "installed" }
  } catch {
    return { shell, rcFile, status: "failed" }
  }
}

/**
 * Remove ambient shell hooks from an rc file.
 * Finds and removes the section between the start/end markers.
 */
export function uninstallShellHooks(rcFile: string): InstallResult {
  const shell = shellFromRcFile(rcFile)

  try {
    if (!existsSync(rcFile)) {
      return { shell, rcFile, status: "skipped" }
    }

    const content = readFileSync(rcFile, "utf-8")

    const startIdx = content.indexOf(START_MARKER)
    if (startIdx === -1) {
      return { shell, rcFile, status: "skipped" }
    }

    const endIdx = content.indexOf(END_MARKER)
    if (endIdx === -1) {
      return { shell, rcFile, status: "skipped" }
    }

    const endOfMarker = endIdx + END_MARKER.length
    // Remove the marker section and any trailing newline
    const before = content.slice(0, startIdx)
    let after = content.slice(endOfMarker)
    if (after.startsWith("\n")) {
      after = after.slice(1)
    }

    writeFileSync(rcFile, before + after)
    return { shell, rcFile, status: "installed" }
  } catch {
    return { shell, rcFile, status: "failed" }
  }
}

/**
 * Get the path to the shell script for a given shell.
 */
export function getShellScriptPath(shell: "zsh" | "bash" | "fish", ambientRoot: string): string {
  const ext = shell === "fish" ? "fish" : shell
  return join(ambientRoot, "shell", `ambient.${ext}`)
}

function buildSourceBlock(shell: string, scriptPath: string): string {
  const lines: string[] = [START_MARKER]

  if (shell === "fish") {
    lines.push(`if test -f ${scriptPath}`)
    lines.push(`    source ${scriptPath}`)
    lines.push("end")
  } else {
    // bash and zsh use the same syntax
    lines.push(`[ -f "${scriptPath}" ] && source "${scriptPath}"`)
  }

  lines.push(END_MARKER)
  lines.push("") // trailing newline
  return lines.join("\n")
}

function shellFromPath(scriptPath: string): string {
  if (scriptPath.endsWith(".bash")) return "bash"
  if (scriptPath.endsWith(".fish")) return "fish"
  if (scriptPath.endsWith(".zsh")) return "zsh"
  return "unknown"
}

function shellFromRcFile(rcFile: string): string {
  if (rcFile.endsWith(".bashrc")) return "bash"
  if (rcFile.endsWith("config.fish")) return "fish"
  if (rcFile.endsWith(".zshrc")) return "zsh"
  return "unknown"
}
