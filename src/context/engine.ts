import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CommandRecord, ContextUpdatePayload, ProjectInfo, ShellContext } from "../types/index.js"

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
  private projectInfo: ProjectInfo | null = null
  private pendingCommand: string | null = null
  private lastOutput: string | null = null

  // Failure tracking for proactive suggestions
  private pendingSuggestion: string | null = null
  private lastSuggestionTime = 0

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

          // Check for repeated failures to generate proactive suggestions
          this.checkForRepeatedFailures()
        }
        break

      case "chpwd":
        this.cwd = event.cwd
        this.detectProject()
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
      projectInfo: this.projectInfo,
      env: {},
    }
  }

  /**
   * Check if there's a pending proactive suggestion.
   * Returns the suggestion message, or null. Clears the suggestion after reading.
   */
  getPendingSuggestion(): string | null {
    const suggestion = this.pendingSuggestion
    this.pendingSuggestion = null
    return suggestion
  }

  /**
   * Detect repeated failures of similar commands (same base command
   * failing 3+ times within 5 minutes). Generates a suggestion if found.
   */
  private checkForRepeatedFailures(): void {
    const FAILURE_THRESHOLD = 3
    const WINDOW_MS = 5 * 60 * 1000
    const COOLDOWN_MS = 5 * 60 * 1000

    // Rate-limit suggestions
    if (Date.now() - this.lastSuggestionTime < COOLDOWN_MS) return

    const now = Date.now()
    const recentFailures = this.recentCommands.filter(
      (c) => c.exitCode !== 0 && now - c.timestamp < WINDOW_MS,
    )

    if (recentFailures.length < FAILURE_THRESHOLD) return

    // Group by base command (first word)
    const groups = new Map<string, number>()
    for (const cmd of recentFailures) {
      const base = cmd.command.split(/\s+/)[0] ?? cmd.command
      groups.set(base, (groups.get(base) ?? 0) + 1)
    }

    for (const [base, count] of groups) {
      if (count >= FAILURE_THRESHOLD) {
        this.pendingSuggestion = `\`${base}\` has failed ${count} times. Run \`r fix\` to investigate.`
        this.lastSuggestionTime = now
        return
      }
    }
  }

  /**
   * Store captured command output (from `r capture` or shell hook).
   * Stored for both formatForPrompt() (cleared after use) and
   * getLastOutput() (persistent until next store).
   */
  storeOutput(output: string): void {
    const MAX_OUTPUT_LENGTH = 10000
    this.lastOutput = output.length > MAX_OUTPUT_LENGTH
      ? output.slice(-MAX_OUTPUT_LENGTH)
      : output
  }

  /**
   * Get the last stored output without clearing it.
   * Used by the assist handler to include command output in the prompt.
   */
  getLastOutput(): string | null {
    return this.lastOutput
  }

  /**
   * Detect project type and metadata from marker files in the current directory.
   */
  private detectProject(): void {
    this.projectType = null
    this.projectInfo = null

    const cwd = this.cwd

    if (existsSync(join(cwd, "package.json"))) {
      this.projectType = "node"
      this.projectInfo = this.detectNodeProject(cwd)
    } else if (existsSync(join(cwd, "Cargo.toml"))) {
      this.projectType = "rust"
      this.projectInfo = { type: "rust", scripts: this.extractCargoScripts(cwd) }
    } else if (existsSync(join(cwd, "go.mod"))) {
      this.projectType = "go"
      this.projectInfo = { type: "go", scripts: this.extractGoScripts(cwd) }
    } else if (existsSync(join(cwd, "pyproject.toml"))) {
      this.projectType = "python"
      this.projectInfo = { type: "python", scripts: this.extractPythonScripts(cwd) }
    } else if (existsSync(join(cwd, "deno.json")) || existsSync(join(cwd, "deno.jsonc"))) {
      this.projectType = "deno"
      this.projectInfo = this.detectDenoProject(cwd)
    } else if (existsSync(join(cwd, "Makefile"))) {
      this.projectType = "make"
      this.projectInfo = { type: "make", scripts: this.extractMakeTargets(cwd) }
    } else if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
      this.projectType = "java"
      this.projectInfo = { type: "java", scripts: ["build", "test", "run"] }
    } else if (existsSync(join(cwd, "mix.exs"))) {
      this.projectType = "elixir"
      this.projectInfo = { type: "elixir", scripts: ["mix compile", "mix test", "mix run"] }
    }
  }

  private detectNodeProject(cwd: string): ProjectInfo {
    const scripts: string[] = []
    let packageManager: string | undefined
    let framework: string | undefined

    try {
      const raw = readFileSync(join(cwd, "package.json"), "utf-8")
      const pkg = JSON.parse(raw) as Record<string, unknown>

      const pkgScripts = pkg["scripts"] as Record<string, string> | undefined
      if (pkgScripts) {
        scripts.push(...Object.keys(pkgScripts))
      }

      const deps = {
        ...(pkg["dependencies"] as Record<string, string> | undefined),
        ...(pkg["devDependencies"] as Record<string, string> | undefined),
      }
      if (deps["next"]) framework = "next"
      else if (deps["nuxt"]) framework = "nuxt"
      else if (deps["remix"]) framework = "remix"
      else if (deps["react"]) framework = "react"
      else if (deps["vue"]) framework = "vue"
      else if (deps["svelte"]) framework = "svelte"
      else if (deps["express"]) framework = "express"
    } catch {
      // ignore parse errors
    }

    if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm"
    else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn"
    else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) packageManager = "bun"
    else packageManager = "npm"

    return { type: "node", packageManager, scripts, framework }
  }

  private detectDenoProject(cwd: string): ProjectInfo {
    const scripts: string[] = []
    const configFile = existsSync(join(cwd, "deno.json")) ? "deno.json" : "deno.jsonc"
    try {
      const raw = readFileSync(join(cwd, configFile), "utf-8")
      const config = JSON.parse(raw) as Record<string, unknown>
      const tasks = config["tasks"] as Record<string, string> | undefined
      if (tasks) scripts.push(...Object.keys(tasks))
    } catch {
      // ignore
    }
    return { type: "deno", scripts }
  }

  private extractCargoScripts(cwd: string): string[] {
    const scripts = ["build", "test", "run", "check", "clippy"]
    // Check for workspace
    try {
      const raw = readFileSync(join(cwd, "Cargo.toml"), "utf-8")
      if (raw.includes("[workspace]")) {
        scripts.push("workspace")
      }
    } catch {
      // ignore
    }
    return scripts
  }

  private extractGoScripts(cwd: string): string[] {
    const scripts = ["build", "test", "run", "vet"]
    if (existsSync(join(cwd, "Makefile"))) {
      scripts.push(...this.extractMakeTargets(cwd))
    }
    return scripts
  }

  private extractPythonScripts(cwd: string): string[] {
    const scripts: string[] = []
    try {
      const raw = readFileSync(join(cwd, "pyproject.toml"), "utf-8")
      // Simple extraction of [tool.poetry.scripts] or [project.scripts] keys
      const scriptSection = raw.match(/\[(?:tool\.poetry\.scripts|project\.scripts)\]\s*\n((?:[^\[]*\n)*)/)?.[1]
      if (scriptSection) {
        const keys = scriptSection.match(/^(\w[\w-]*)\s*=/gm)
        if (keys) {
          scripts.push(...keys.map(k => k.replace(/\s*=.*/, "")))
        }
      }
    } catch {
      // ignore
    }
    if (existsSync(join(cwd, "Makefile"))) {
      scripts.push(...this.extractMakeTargets(cwd))
    }
    return scripts
  }

  private extractMakeTargets(cwd: string): string[] {
    try {
      const raw = readFileSync(join(cwd, "Makefile"), "utf-8")
      const targets = raw.match(/^([a-zA-Z_][\w-]*)\s*:/gm)
      if (targets) {
        return targets
          .map(t => t.replace(/:.*/, ""))
          .filter(t => !t.startsWith("_") && !t.startsWith("."))
          .slice(0, 20) // cap to avoid noise
      }
    } catch {
      // ignore
    }
    return []
  }

  /**
   * Format context as a human-readable string for prompt injection.
   */
  formatForPrompt(): string {
    const lines: string[] = []

    lines.push(`Working directory: ${this.cwd}`)

    if (this.gitBranch) {
      lines.push(`Git branch: ${this.gitBranch}${this.gitDirty ? " (uncommitted changes)" : ""}`)
    }

    if (this.projectInfo) {
      const pm = this.projectInfo.packageManager ? ` (${this.projectInfo.packageManager})` : ""
      const fw = this.projectInfo.framework ? `, ${this.projectInfo.framework}` : ""
      const scripts = this.projectInfo.scripts.length > 0
        ? ` — scripts: ${this.projectInfo.scripts.slice(0, 10).join(", ")}${this.projectInfo.scripts.length > 10 ? "…" : ""}`
        : ""
      lines.push(`Project: ${this.projectInfo.type}${pm}${fw}${scripts}`)
    } else if (this.projectType) {
      lines.push(`Project type: ${this.projectType}`)
    }

    if (this.lastCommand) {
      const status = this.lastExitCode === 0 ? "success" : `failed (exit ${this.lastExitCode})`
      lines.push(`Last command: \`${this.lastCommand}\` → ${status}`)
    }

    // Include captured output when the last command failed
    if (this.lastOutput && this.lastExitCode !== 0) {
      const outputLines = this.lastOutput.trimEnd().split("\n")
      const tail = outputLines.slice(-30).join("\n")
      lines.push(`Error output (last ${Math.min(outputLines.length, 30)} lines):`)
      lines.push(tail)
      // Clear after consumption so it's only injected once
      this.lastOutput = null
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

    return lines.join("\n")
  }
}
