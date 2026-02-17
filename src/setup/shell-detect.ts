import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

export interface ShellInfo {
  shell: "zsh" | "bash" | "fish" | "unknown"
  rcFile: string
  version: string | null
  meetsMinVersion: boolean
}

/**
 * Detect the user's default shell from $SHELL.
 */
export function detectShell(): ShellInfo {
  const shellPath = process.env["SHELL"] ?? ""

  if (shellPath.endsWith("/zsh")) {
    return { shell: "zsh", rcFile: join(homedir(), ".zshrc"), version: getVersion("zsh"), meetsMinVersion: true }
  }
  if (shellPath.endsWith("/bash")) {
    const v = getVersion("bash")
    return { shell: "bash", rcFile: join(homedir(), ".bashrc"), version: v, meetsMinVersion: versionAtLeast(v, "4.0") }
  }
  if (shellPath.endsWith("/fish")) {
    const v = getVersion("fish")
    return { shell: "fish", rcFile: join(homedir(), ".config", "fish", "config.fish"), version: v, meetsMinVersion: versionAtLeast(v, "3.1") }
  }

  return { shell: "unknown", rcFile: "", version: null, meetsMinVersion: false }
}

/**
 * Detect all installed shells (zsh, bash, fish) regardless of $SHELL.
 * Checks for each shell binary via `which`.
 */
export function detectAllShells(): ShellInfo[] {
  const shells: ShellInfo[] = []

  if (commandExists("zsh")) {
    shells.push({ shell: "zsh", rcFile: join(homedir(), ".zshrc"), version: getVersion("zsh"), meetsMinVersion: true })
  }
  if (commandExists("bash")) {
    const v = getVersion("bash")
    shells.push({ shell: "bash", rcFile: join(homedir(), ".bashrc"), version: v, meetsMinVersion: versionAtLeast(v, "4.0") })
  }
  if (commandExists("fish")) {
    const v = getVersion("fish")
    shells.push({ shell: "fish", rcFile: join(homedir(), ".config", "fish", "config.fish"), version: v, meetsMinVersion: versionAtLeast(v, "3.1") })
  }

  return shells
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

function getVersion(cmd: string): string | null {
  try {
    const output = execFileSync(cmd, ["--version"], { stdio: "pipe", encoding: "utf-8", timeout: 3000 })
    // bash: "GNU bash, version 5.2.15(1)-release ..."
    // fish: "fish, version 3.7.1"
    // zsh:  "zsh 5.9 (x86_64-apple-darwin23.0)"
    const match = output.match(/(\d+\.\d+(?:\.\d+)?)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false

  const vParts = version.split(".").map(Number)
  const mParts = min.split(".").map(Number)

  const major = vParts[0] ?? 0
  const minor = vParts[1] ?? 0
  const minMajor = mParts[0] ?? 0
  const minMinor = mParts[1] ?? 0

  if (major > minMajor) return true
  if (major === minMajor && minor >= minMinor) return true
  return false
}
