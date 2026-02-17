import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ContextEngine } from "../../src/context/engine.js"

describe("ContextEngine", () => {
  let engine: ContextEngine
  let tmpDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    tmpDir = join(tmpdir(), `ambient-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    engine = new ContextEngine()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ---- State tracking ----

  describe("state tracking", () => {
    it("stores pending command on preexec event", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "npm test" })
      // The pending command is internal, but it manifests when precmd fires
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 0 })
      const ctx = engine.getContext()
      expect(ctx.lastCommand).toBe("npm test")
    })

    it("records command and exit code into recentCommands on precmd", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "ls -la" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 0 })

      const ctx = engine.getContext()
      expect(ctx.recentCommands).toHaveLength(1)
      expect(ctx.recentCommands[0]!.command).toBe("ls -la")
      expect(ctx.recentCommands[0]!.exitCode).toBe(0)
    })

    it("handles precmd without prior preexec gracefully", () => {
      // No preexec was fired, so precmd should not crash or record anything
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 0 })
      const ctx = engine.getContext()
      expect(ctx.recentCommands).toHaveLength(0)
      expect(ctx.lastCommand).toBeNull()
    })

    it("updates cwd on chpwd", () => {
      const newDir = join(tmpDir, "subdir")
      mkdirSync(newDir)
      engine.update({ event: "chpwd", cwd: newDir })
      const ctx = engine.getContext()
      expect(ctx.cwd).toBe(newDir)
    })

    it("updates git branch and dirty state from payload", () => {
      engine.update({
        event: "precmd",
        cwd: tmpDir,
        gitBranch: "feature/auth",
        gitDirty: true,
      })
      const ctx = engine.getContext()
      expect(ctx.gitBranch).toBe("feature/auth")
      expect(ctx.gitDirty).toBe(true)
    })

    it("caps ring buffer at 50 commands", () => {
      for (let i = 0; i < 60; i++) {
        engine.update({ event: "preexec", cwd: tmpDir, command: `cmd-${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 0 })
      }

      const ctx = engine.getContext()
      expect(ctx.recentCommands).toHaveLength(50)
      // Oldest should have been dropped
      expect(ctx.recentCommands[0]!.command).toBe("cmd-10")
      expect(ctx.recentCommands[49]!.command).toBe("cmd-59")
    })

    it("records exit code for failed commands", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "make build" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 2 })

      const ctx = engine.getContext()
      expect(ctx.lastExitCode).toBe(2)
      expect(ctx.recentCommands[0]!.exitCode).toBe(2)
    })

    it("defaults exit code to 0 when not provided", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "echo hello" })
      engine.update({ event: "precmd", cwd: tmpDir })

      const ctx = engine.getContext()
      expect(ctx.lastExitCode).toBe(0)
    })
  })

  // ---- Repeated failure detection ----

  describe("repeated failure detection", () => {
    it("generates suggestion after 3 failures of same base command within 5 min", () => {
      const now = Date.now()

      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `pnpm build --flag-${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const suggestion = engine.getPendingSuggestion()
      expect(suggestion).toBeTruthy()
      expect(suggestion).toContain("pnpm")
      expect(suggestion).toContain("failed")
    })

    it("does not suggest after only 2 failures", () => {
      const now = Date.now()

      for (let i = 0; i < 2; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `pnpm build --flag-${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const suggestion = engine.getPendingSuggestion()
      expect(suggestion).toBeNull()
    })

    it("does not suggest when failures are from different base commands", () => {
      const now = Date.now()

      const commands = ["npm test", "pnpm build", "cargo check"]
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: commands[i]! })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const suggestion = engine.getPendingSuggestion()
      expect(suggestion).toBeNull()
    })

    it("suppresses second suggestion within 5 min cooldown", () => {
      const now = Date.now()

      // First round of failures
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `pnpm build ${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const first = engine.getPendingSuggestion()
      expect(first).toBeTruthy()

      // Second round of failures within cooldown
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + 60_000 + i * 1000) // 1 minute later
        engine.update({ event: "preexec", cwd: tmpDir, command: `pnpm build retry-${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const second = engine.getPendingSuggestion()
      expect(second).toBeNull()
    })

    it("getPendingSuggestion returns and clears the suggestion", () => {
      const now = Date.now()

      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `npm test ${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const first = engine.getPendingSuggestion()
      expect(first).toBeTruthy()

      const second = engine.getPendingSuggestion()
      expect(second).toBeNull()
    })

    it("allows suggestion again after cooldown expires", () => {
      const now = Date.now()

      // First round
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(now + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `npm test ${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }
      engine.getPendingSuggestion() // consume

      // Second round after 6 minutes (past 5 min cooldown)
      const later = now + 6 * 60 * 1000
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(later + i * 1000)
        engine.update({ event: "preexec", cwd: tmpDir, command: `npm test again-${i}` })
        engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      }

      const suggestion = engine.getPendingSuggestion()
      expect(suggestion).toBeTruthy()
    })
  })

  // ---- Project detection ----

  describe("project detection", () => {
    it("detects Node project from package.json", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
        name: "test-pkg",
        scripts: { build: "tsc", test: "vitest" },
      }))

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectType).toBe("node")
      expect(ctx.projectInfo?.type).toBe("node")
    })

    it("detects Rust project from Cargo.toml", () => {
      writeFileSync(join(tmpDir, "Cargo.toml"), '[package]\nname = "test"\nversion = "0.1.0"')

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectType).toBe("rust")
      expect(ctx.projectInfo?.type).toBe("rust")
    })

    it("detects Go project from go.mod", () => {
      writeFileSync(join(tmpDir, "go.mod"), "module example.com/test\n\ngo 1.21")

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectType).toBe("go")
      expect(ctx.projectInfo?.type).toBe("go")
    })

    it("detects Python project from pyproject.toml", () => {
      writeFileSync(join(tmpDir, "pyproject.toml"), '[project]\nname = "test"')

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectType).toBe("python")
      expect(ctx.projectInfo?.type).toBe("python")
    })

    it("returns null for directories with no marker files", () => {
      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectType).toBeNull()
      expect(ctx.projectInfo).toBeNull()
    })

    it("detects pnpm package manager from pnpm-lock.yaml", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }))
      writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n")

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.packageManager).toBe("pnpm")
    })

    it("detects yarn package manager from yarn.lock", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }))
      writeFileSync(join(tmpDir, "yarn.lock"), "# yarn lockfile v1\n")

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.packageManager).toBe("yarn")
    })

    it("detects bun package manager from bun.lockb", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }))
      writeFileSync(join(tmpDir, "bun.lockb"), "")

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.packageManager).toBe("bun")
    })

    it("defaults to npm when no lock file present", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }))

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.packageManager).toBe("npm")
    })

    it("extracts scripts from package.json", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
      }))

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.scripts).toContain("build")
      expect(ctx.projectInfo?.scripts).toContain("test")
      expect(ctx.projectInfo?.scripts).toContain("lint")
    })

    it("detects framework from dependencies", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        dependencies: { react: "^18.0.0" },
      }))

      engine.update({ event: "chpwd", cwd: tmpDir })
      const ctx = engine.getContext()
      expect(ctx.projectInfo?.framework).toBe("react")
    })
  })

  // ---- formatForPrompt ----

  describe("formatForPrompt", () => {
    it("includes cwd in output", () => {
      engine.update({ event: "chpwd", cwd: tmpDir })
      const formatted = engine.formatForPrompt()
      expect(formatted).toContain(tmpDir)
    })

    it("includes git branch info", () => {
      engine.update({ event: "precmd", cwd: tmpDir, gitBranch: "main", gitDirty: false })
      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("Git branch: main")
    })

    it("shows uncommitted changes indicator", () => {
      engine.update({ event: "precmd", cwd: tmpDir, gitBranch: "main", gitDirty: true })
      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("uncommitted changes")
    })

    it("includes project info when detected", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
        name: "test",
        scripts: { build: "tsc" },
      }))
      writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "")

      engine.update({ event: "chpwd", cwd: tmpDir })
      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("node")
      expect(formatted).toContain("pnpm")
    })

    it("includes recent commands in output", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "npm test" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 0 })
      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("npm test")
    })

    it("shows error output when last command failed", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "make build" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      engine.storeOutput("Error: compilation failed\nline 42: syntax error")

      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("Error output")
      expect(formatted).toContain("compilation failed")
    })

    it("shows last command exit status", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "cargo build" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 101 })

      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("failed (exit 101)")
    })

    it("lists recent failures", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "npm test" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      engine.update({ event: "preexec", cwd: tmpDir, command: "npm build" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 2 })

      const formatted = engine.formatForPrompt()
      expect(formatted).toContain("Recent failures")
      expect(formatted).toContain("npm test")
      expect(formatted).toContain("exit 1")
    })
  })

  // ---- Output storage ----

  describe("storeOutput / getLastOutput", () => {
    it("stores and retrieves output", () => {
      engine.storeOutput("some command output")
      expect(engine.getLastOutput()).toBe("some command output")
    })

    it("truncates very long output", () => {
      const long = "x".repeat(20000)
      engine.storeOutput(long)
      expect(engine.getLastOutput()!.length).toBeLessThanOrEqual(10000)
    })

    it("clears stored output after formatting when last command failed", () => {
      engine.update({ event: "preexec", cwd: tmpDir, command: "failing-cmd" })
      engine.update({ event: "precmd", cwd: tmpDir, exitCode: 1 })
      engine.storeOutput("error details here")

      // First call consumes the output
      const first = engine.formatForPrompt()
      expect(first).toContain("error details here")

      // Second call should not include it
      const second = engine.formatForPrompt()
      expect(second).not.toContain("error details here")
    })
  })
})
