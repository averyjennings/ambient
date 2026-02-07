import type { CommandRecord, ContextUpdatePayload, ShellContext } from "../types/index.js"

const MAX_RECENT_COMMANDS = 50

/**
 * The context engine maintains ambient awareness of the user's shell session.
 * It is fed by shell hooks (preexec, precmd, chpwd) and provides rich context
 * to agents when invoked.
 */
export class ContextEngine {
  private cwd = process.env["HOME"] ?? "/"
  private gitBranch: string | null = null
  private gitDirty = false
  private lastCommand: string | null = null
  private lastExitCode: number | null = null
  private recentCommands: CommandRecord[] = []
  private projectType: string | null = null
  private pendingCommand: string | null = null

  update(event: ContextUpdatePayload): void {
    this.cwd = event.cwd

    if (event.gitBranch !== undefined) {
      this.gitBranch = event.gitBranch
    }
    if (event.gitDirty !== undefined) {
      this.gitDirty = event.gitDirty
    }

    switch (event.event) {
      case "preexec":
        // Command is about to run — store it as pending
        this.pendingCommand = event.command ?? null
        break

      case "precmd":
        // Command just finished — record it with exit code
        if (this.pendingCommand) {
          const record: CommandRecord = {
            command: this.pendingCommand,
            exitCode: event.exitCode ?? 0,
            cwd: event.cwd,
            timestamp: Date.now(),
          }
          this.recentCommands.push(record)
          if (this.recentCommands.length > MAX_RECENT_COMMANDS) {
            this.recentCommands = this.recentCommands.slice(-MAX_RECENT_COMMANDS)
          }
          this.lastCommand = this.pendingCommand
          this.lastExitCode = event.exitCode ?? 0
          this.pendingCommand = null
        }
        break

      case "chpwd":
        this.cwd = event.cwd
        this.projectType = null // reset — will be re-detected
        break
    }
  }

  getContext(): ShellContext {
    return {
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      gitDirty: this.gitDirty,
      lastCommand: this.lastCommand,
      lastExitCode: this.lastExitCode,
      recentCommands: [...this.recentCommands],
      projectType: this.projectType,
      env: {},
    }
  }

  /**
   * Format context as a human-readable string for prompt injection.
   */
  formatForPrompt(): string {
    const lines: string[] = []

    lines.push(`Working directory: ${this.cwd}`)

    if (this.gitBranch) {
      lines.push(`Git branch: ${this.gitBranch}${this.gitDirty ? " (dirty)" : ""}`)
    }

    if (this.lastCommand) {
      const status = this.lastExitCode === 0 ? "success" : `failed (exit ${this.lastExitCode})`
      lines.push(`Last command: \`${this.lastCommand}\` → ${status}`)
    }

    const recentFailed = this.recentCommands
      .filter((c) => c.exitCode !== 0)
      .slice(-3)
    if (recentFailed.length > 0) {
      lines.push("Recent failures:")
      for (const cmd of recentFailed) {
        lines.push(`  - \`${cmd.command}\` → exit ${cmd.exitCode}`)
      }
    }

    if (this.projectType) {
      lines.push(`Project type: ${this.projectType}`)
    }

    return lines.join("\n")
  }
}
