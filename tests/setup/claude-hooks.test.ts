import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Mock os.homedir() before importing the module
let mockHomeDir: string

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:os")
  return {
    ...actual,
    homedir: () => mockHomeDir,
  }
})

// Import after mock is set up
const { ensureClaudeHooks } = await import("../../src/setup/claude-hooks.js")

describe("ensureClaudeHooks", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ambient-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    mockHomeDir = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates hook scripts in ~/.ambient/hooks/ with correct permissions", () => {
    ensureClaudeHooks()

    const hooksDir = join(tmpDir, ".ambient", "hooks")
    expect(existsSync(hooksDir)).toBe(true)

    const remindScript = join(hooksDir, "ambient-remind.sh")
    const activityScript = join(hooksDir, "ambient-activity.sh")
    const flushScript = join(hooksDir, "ambient-flush.sh")

    expect(existsSync(remindScript)).toBe(true)
    expect(existsSync(activityScript)).toBe(true)
    expect(existsSync(flushScript)).toBe(true)

    // Check executable permission (mode 0o755 = rwxr-xr-x)
    const remindStat = statSync(remindScript)
    // Check that owner-execute bit is set
    expect(remindStat.mode & 0o100).toBeTruthy()

    const activityStat = statSync(activityScript)
    expect(activityStat.mode & 0o100).toBeTruthy()

    const flushStat = statSync(flushScript)
    expect(flushStat.mode & 0o100).toBeTruthy()
  })

  it("creates ~/.claude/settings.json if it does not exist", () => {
    const settingsPath = join(tmpDir, ".claude", "settings.json")
    expect(existsSync(settingsPath)).toBe(false)

    ensureClaudeHooks()

    expect(existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    expect(settings.hooks).toBeDefined()
  })

  it("adds all 4 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop)", () => {
    const result = ensureClaudeHooks()

    expect(result.added).toContain("SessionStart")
    expect(result.added).toContain("UserPromptSubmit")
    expect(result.added).toContain("PostToolUse")
    expect(result.added).toContain("Stop")
    expect(result.added).toHaveLength(4)

    const settingsPath = join(tmpDir, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))

    expect(settings.hooks["SessionStart"]).toBeDefined()
    expect(settings.hooks["UserPromptSubmit"]).toBeDefined()
    expect(settings.hooks["PostToolUse"]).toBeDefined()
    expect(settings.hooks["Stop"]).toBeDefined()
  })

  it("is idempotent: skips when hooks are already present", () => {
    // First call adds
    const first = ensureClaudeHooks()
    expect(first.added).toHaveLength(4)
    expect(first.skipped).toHaveLength(0)

    // Second call should skip all
    const second = ensureClaudeHooks()
    expect(second.added).toHaveLength(0)
    expect(second.skipped).toHaveLength(4)
    expect(second.skipped).toContain("SessionStart")
    expect(second.skipped).toContain("UserPromptSubmit")
    expect(second.skipped).toContain("PostToolUse")
    expect(second.skipped).toContain("Stop")
  })

  it("preserves existing settings keys", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true })
    const settingsPath = join(tmpDir, ".claude", "settings.json")
    writeFileSync(settingsPath, JSON.stringify({
      myCustomKey: "preserved-value",
      anotherSetting: { nested: true },
    }))

    ensureClaudeHooks()

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    expect(settings.myCustomKey).toBe("preserved-value")
    expect(settings.anotherSetting).toEqual({ nested: true })
    expect(settings.hooks).toBeDefined()
  })

  it("PostToolUse has matcher 'Edit|Write|Bash'", () => {
    ensureClaudeHooks()

    const settingsPath = join(tmpDir, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))

    const postToolUseEntries = settings.hooks["PostToolUse"] as Array<{
      matcher?: string
      hooks: Array<{ type: string; command: string; async?: boolean }>
    }>
    expect(postToolUseEntries).toBeDefined()
    expect(postToolUseEntries.length).toBeGreaterThan(0)

    // Find the ambient entry
    const ambientEntry = postToolUseEntries.find(e => e.matcher === "Edit|Write|Bash")
    expect(ambientEntry).toBeDefined()
    expect(ambientEntry!.hooks[0]!.async).toBe(true)
  })

  it("SessionStart hook echoes a reminder message", () => {
    ensureClaudeHooks()

    const settingsPath = join(tmpDir, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))

    const sessionStartEntries = settings.hooks["SessionStart"] as Array<{
      hooks: Array<{ type: string; command: string }>
    }>
    expect(sessionStartEntries.length).toBeGreaterThan(0)

    const hookCommand = sessionStartEntries[0]!.hooks[0]!.command
    expect(hookCommand).toContain("echo")
    expect(hookCommand).toContain("AMBIENT")
    expect(hookCommand).toContain("get_task_context")
  })

  it("hook scripts contain expected content", () => {
    ensureClaudeHooks()

    const hooksDir = join(tmpDir, ".ambient", "hooks")

    // Remind script should have 20-minute interval
    const remindContent = readFileSync(join(hooksDir, "ambient-remind.sh"), "utf-8")
    expect(remindContent).toContain("#!/bin/bash")
    expect(remindContent).toContain("1200")

    // Activity script should capture tool info
    const activityContent = readFileSync(join(hooksDir, "ambient-activity.sh"), "utf-8")
    expect(activityContent).toContain("tool_name")
    expect(activityContent).toContain("ambient notify")

    // Flush script should handle transcript
    const flushContent = readFileSync(join(hooksDir, "ambient-flush.sh"), "utf-8")
    expect(flushContent).toContain("transcript_path")
    expect(flushContent).toContain("activity-flush")
  })

  it("Stop hook is async", () => {
    ensureClaudeHooks()

    const settingsPath = join(tmpDir, ".claude", "settings.json")
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))

    const stopEntries = settings.hooks["Stop"] as Array<{
      hooks: Array<{ type: string; command: string; async?: boolean }>
    }>
    expect(stopEntries.length).toBeGreaterThan(0)
    expect(stopEntries[0]!.hooks[0]!.async).toBe(true)
  })

  it("does not duplicate hook entries when settings already have unrelated hooks", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true })
    const settingsPath = join(tmpDir, ".claude", "settings.json")
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo 'my custom hook'" }] },
        ],
      },
    }))

    const result = ensureClaudeHooks()
    expect(result.added).toContain("SessionStart")

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
    // Should have 2 entries: the custom one + the ambient one
    expect(settings.hooks["SessionStart"]).toHaveLength(2)
  })
})
