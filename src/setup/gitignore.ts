import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * Ensure .ambient/ is in the user's global gitignore.
 * Creates the global gitignore file and configures git if needed.
 * Returns "added" | "already-present" | "failed".
 */
export function ensureGlobalGitignore(): "added" | "already-present" | "failed" {
  try {
    const excludesPath = resolveGlobalExcludesFile()

    if (existsSync(excludesPath)) {
      const content = readFileSync(excludesPath, "utf-8")
      if (/^\.ambient\/?$/m.test(content)) {
        return "already-present"
      }
      appendFileSync(excludesPath, "\n.ambient/\n")
    } else {
      writeFileSync(excludesPath, ".ambient/\n")
    }

    return "added"
  } catch {
    return "failed"
  }
}

/**
 * Resolve the path to the global git excludes file.
 * Reads from git config, falling back to ~/.config/git/ignore.
 * Sets the git config if no excludes file is configured.
 */
function resolveGlobalExcludesFile(): string {
  // Check if git already has a global excludes file configured
  try {
    const configured = execFileSync("git", ["config", "--global", "core.excludesFile"], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()

    if (configured) {
      // Expand ~ to home directory
      return configured.startsWith("~")
        ? join(homedir(), configured.slice(1))
        : configured
    }
  } catch {
    // Not configured — fall through
  }

  // Default location per XDG convention
  const defaultPath = join(homedir(), ".config", "git", "ignore")

  // Configure git to use this path
  try {
    execFileSync("git", ["config", "--global", "core.excludesFile", defaultPath], {
      timeout: 2_000,
      stdio: "ignore",
    })
  } catch {
    // If we can't set the config, still try to write the file
  }

  return defaultPath
}
