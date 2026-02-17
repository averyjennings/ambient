import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { looksLikeNaturalLanguage, classifyCommand, parseAndStoreMemoryJsonLines } from "../../src/daemon/classify.js"
import type { MemoryKey } from "../../src/types/index.js"

// --- looksLikeNaturalLanguage ---

describe("looksLikeNaturalLanguage", () => {
  it("returns false for empty string", () => {
    expect(looksLikeNaturalLanguage("")).toBe(false)
  })

  it("returns false for whitespace only", () => {
    expect(looksLikeNaturalLanguage("   ")).toBe(false)
  })

  it("returns false for single word (likely a command)", () => {
    expect(looksLikeNaturalLanguage("ls")).toBe(false)
  })

  it("returns false for 'git status' (looks like a command)", () => {
    expect(looksLikeNaturalLanguage("git status")).toBe(false)
  })

  it("returns true for 'what is this?' (has question mark)", () => {
    expect(looksLikeNaturalLanguage("what is this?")).toBe(true)
  })

  it("returns true for 'why did the build fail' (starts with conversational word)", () => {
    expect(looksLikeNaturalLanguage("why did the build fail")).toBe(true)
  })

  it("returns true for contractions like 'what's going on'", () => {
    expect(looksLikeNaturalLanguage("what's going on")).toBe(true)
  })

  it("returns false for 'npm install react'", () => {
    expect(looksLikeNaturalLanguage("npm install react")).toBe(false)
  })

  it("returns true for 'explain this code'", () => {
    expect(looksLikeNaturalLanguage("explain this code")).toBe(true)
  })

  it("returns true for 'how do I fix this'", () => {
    expect(looksLikeNaturalLanguage("how do I fix this")).toBe(true)
  })

  it("returns false for 'pnpm build'", () => {
    expect(looksLikeNaturalLanguage("pnpm build")).toBe(false)
  })

  it("returns true for 'tell me about the auth system'", () => {
    expect(looksLikeNaturalLanguage("tell me about the auth system")).toBe(true)
  })

  it("returns true for question mark in any multi-word input", () => {
    expect(looksLikeNaturalLanguage("docker build?")).toBe(true)
  })

  it("returns true for 'hey what is up'", () => {
    expect(looksLikeNaturalLanguage("hey what is up")).toBe(true)
  })

  it("returns true for 'please help me'", () => {
    expect(looksLikeNaturalLanguage("please help me")).toBe(true)
  })

  it("returns true for 'show me the logs'", () => {
    expect(looksLikeNaturalLanguage("show me the logs")).toBe(true)
  })

  it("returns false for 'docker-compose up -d'", () => {
    expect(looksLikeNaturalLanguage("docker-compose up -d")).toBe(false)
  })

  it("returns true for contraction 'don't do that' (multi-word)", () => {
    expect(looksLikeNaturalLanguage("don't do that")).toBe(true)
  })

  it("returns false for single word with apostrophe", () => {
    // Single word still returns false — contraction check requires >= 2 words
    expect(looksLikeNaturalLanguage("don't")).toBe(false)
  })
})

// --- classifyCommand ---

describe("classifyCommand", () => {
  it("classifies 'git checkout feature/auth' as task-update with branch name", () => {
    const result = classifyCommand("git checkout feature/auth", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("feature/auth")
  })

  it("classifies 'git switch main' as task-update", () => {
    const result = classifyCommand("git switch main", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("main")
  })

  it("classifies 'git commit -m fix bug' as task-update", () => {
    const result = classifyCommand("git commit -m 'fix bug'", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Committed")
  })

  it("classifies 'npm install react' as task-update with package name", () => {
    const result = classifyCommand("npm install react", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("react")
    expect(result!.content).toContain("Installed")
  })

  it("classifies 'pnpm test' with exit code 1 as error-resolution", () => {
    const result = classifyCommand("pnpm test", 1)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("error-resolution")
    expect(result!.content).toContain("failed")
  })

  it("classifies 'pnpm build' with exit code 0 as task-update", () => {
    const result = classifyCommand("pnpm build", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Build passed")
  })

  it("returns null for 'ls -la' (not notable)", () => {
    const result = classifyCommand("ls -la", 0)
    expect(result).toBeNull()
  })

  it("returns null for 'cd /tmp' (not notable)", () => {
    const result = classifyCommand("cd /tmp", 0)
    expect(result).toBeNull()
  })

  it("classifies 'docker build .' with exit code 1 as task-update with medium importance", () => {
    const result = classifyCommand("docker build .", 1)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.importance).toBe("medium")
    expect(result!.content).toContain("failed")
  })

  it("returns null for unknown single-word command with exit 127 (command not found)", () => {
    const result = classifyCommand("unknown_cmd", 127)
    expect(result).toBeNull()
  })

  it("classifies 'make test' with exit 1 as error-resolution", () => {
    const result = classifyCommand("make test", 1)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("error-resolution")
    expect(result!.content).toContain("make test failed")
  })

  it("classifies 'git merge develop' as task-update with medium importance", () => {
    const result = classifyCommand("git merge develop", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.importance).toBe("medium")
    expect(result!.content).toContain("Merged")
  })

  it("classifies 'git stash' as task-update", () => {
    const result = classifyCommand("git stash", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Stashed")
  })

  it("classifies 'git rebase main' as task-update with medium importance", () => {
    const result = classifyCommand("git rebase main", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.importance).toBe("medium")
    expect(result!.content).toContain("Rebased")
  })

  it("classifies 'npm remove express' as task-update with Removed", () => {
    const result = classifyCommand("npm remove express", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Removed")
    expect(result!.content).toContain("express")
  })

  it("classifies 'pnpm add lodash' as task-update", () => {
    const result = classifyCommand("pnpm add lodash", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Installed")
    expect(result!.content).toContain("lodash")
  })

  it("classifies 'terraform apply' success as task-update with medium importance", () => {
    const result = classifyCommand("terraform apply", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.importance).toBe("medium")
    expect(result!.content).toContain("succeeded")
  })

  it("classifies 'terraform plan' failure as task-update with failed", () => {
    const result = classifyCommand("terraform plan", 1)
    expect(result).not.toBeNull()
    expect(result!.content).toContain("failed")
  })

  it("classifies lint failure as error-resolution with low importance", () => {
    const result = classifyCommand("eslint src/", 1)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("error-resolution")
    expect(result!.importance).toBe("low")
    expect(result!.content).toContain("Lint failed")
  })

  it("classifies vitest success as task-update", () => {
    const result = classifyCommand("vitest run", 0)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("task-update")
    expect(result!.content).toContain("Tests passed")
  })

  it("classifies generic multi-word command failure (non-127) as error-resolution", () => {
    const result = classifyCommand("some-cli deploy production", 2)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("error-resolution")
    expect(result!.importance).toBe("low")
  })

  it("returns null for successful generic command", () => {
    const result = classifyCommand("some-cli deploy production", 0)
    expect(result).toBeNull()
  })

  it("truncates long commands to 120 chars in content", () => {
    const longCmd = "git commit -m " + "a".repeat(200)
    const result = classifyCommand(longCmd, 0)
    expect(result).not.toBeNull()
    // The slice(0,120) applies to the whole cmd
    expect(result!.content.length).toBeLessThan(200)
  })
})

// --- parseAndStoreMemoryJsonLines ---

vi.mock("../../src/memory/store.js", () => ({
  addTaskEvent: vi.fn(),
  addProjectEvent: vi.fn(),
  isDuplicateEvent: vi.fn(() => false),
}))

import { addTaskEvent, addProjectEvent, isDuplicateEvent } from "../../src/memory/store.js"

describe("parseAndStoreMemoryJsonLines", () => {
  const memKey: MemoryKey = {
    projectKey: "test-project",
    taskKey: "test-task",
    projectName: "test",
    branchName: "main",
    origin: "https://github.com/test/test",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Re-establish the default return value after clearAllMocks
    vi.mocked(isDuplicateEvent).mockReturnValue(false)
    // Ensure crypto.randomUUID is available
    if (!globalThis.crypto?.randomUUID) {
      vi.stubGlobal("crypto", {
        randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2),
      })
    }
  })

  it("stores valid JSON lines as task events", () => {
    const input = [
      '{"type":"task-update","content":"Started auth work","importance":"medium"}',
      '{"type":"decision","content":"Use JWT tokens","importance":"high"}',
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(2)
    expect(addTaskEvent).toHaveBeenCalledTimes(2)
  })

  it("calls addProjectEvent for high-importance events", () => {
    const input = '{"type":"decision","content":"Use JWT tokens","importance":"high"}'
    parseAndStoreMemoryJsonLines(input, memKey)

    expect(addProjectEvent).toHaveBeenCalledTimes(1)
    expect(addTaskEvent).toHaveBeenCalledTimes(1)
  })

  it("does not call addProjectEvent for non-high-importance events", () => {
    const input = '{"type":"task-update","content":"Minor update","importance":"low"}'
    parseAndStoreMemoryJsonLines(input, memKey)

    expect(addProjectEvent).not.toHaveBeenCalled()
    expect(addTaskEvent).toHaveBeenCalledTimes(1)
  })

  it("skips lines starting with #", () => {
    const input = [
      "# This is a comment",
      '{"type":"task-update","content":"Real event","importance":"medium"}',
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(1)
  })

  it("skips lines starting with //", () => {
    const input = [
      "// This is a comment",
      '{"type":"task-update","content":"Real event","importance":"medium"}',
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(1)
  })

  it("skips items with missing content", () => {
    const input = '{"type":"task-update","importance":"medium"}'
    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(0)
    expect(addTaskEvent).not.toHaveBeenCalled()
  })

  it("skips items with missing type", () => {
    const input = '{"content":"some content","importance":"medium"}'
    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(0)
  })

  it("skips invalid JSON without crashing", () => {
    const input = [
      "this is not json",
      '{"type":"task-update","content":"Valid","importance":"low"}',
      "{broken json here",
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(1)
  })

  it("skips items with invalid type not in validTypes", () => {
    const input = '{"type":"unknown-type","content":"something","importance":"medium"}'
    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(0)
  })

  it("accepts custom validTypes option", () => {
    const input = '{"type":"custom-event","content":"something","importance":"medium"}'
    const count = parseAndStoreMemoryJsonLines(input, memKey, {
      validTypes: ["custom-event"],
    })
    expect(count).toBe(1)
  })

  it("deduplicates within a batch by prefix", () => {
    const input = [
      '{"type":"task-update","content":"Duplicate content here","importance":"medium"}',
      '{"type":"task-update","content":"Duplicate content here","importance":"low"}',
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(1)
    expect(addTaskEvent).toHaveBeenCalledTimes(1)
  })

  it("skips when isDuplicateEvent returns true", () => {
    vi.mocked(isDuplicateEvent).mockReturnValue(true)

    const input = '{"type":"task-update","content":"Already exists","importance":"medium"}'
    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(0)
    expect(addTaskEvent).not.toHaveBeenCalled()
  })

  it("truncates content at 1000 chars", () => {
    const longContent = "a".repeat(2000)
    const input = `{"type":"task-update","content":"${longContent}","importance":"medium"}`
    parseAndStoreMemoryJsonLines(input, memKey)

    expect(addTaskEvent).toHaveBeenCalledTimes(1)
    const eventArg = vi.mocked(addTaskEvent).mock.calls[0]![3] as { content: string }
    expect(eventArg.content.length).toBe(1000)
  })

  it("passes custom metadata through", () => {
    const input = '{"type":"task-update","content":"With metadata","importance":"medium"}'
    parseAndStoreMemoryJsonLines(input, memKey, {
      metadata: { source: "test", file: "foo.ts" },
    })

    expect(addTaskEvent).toHaveBeenCalledTimes(1)
    const eventArg = vi.mocked(addTaskEvent).mock.calls[0]![3] as { metadata?: Record<string, string> }
    expect(eventArg.metadata).toEqual({ source: "test", file: "foo.ts" })
  })

  it("returns correct count of stored events", () => {
    const input = [
      '{"type":"task-update","content":"Event 1","importance":"low"}',
      '{"type":"decision","content":"Event 2","importance":"medium"}',
      '{"type":"error-resolution","content":"Event 3","importance":"high"}',
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(3)
  })

  it("defaults importance to medium when not specified or invalid", () => {
    const input = '{"type":"task-update","content":"No importance","importance":"bogus"}'
    parseAndStoreMemoryJsonLines(input, memKey)

    expect(addTaskEvent).toHaveBeenCalledTimes(1)
    const eventArg = vi.mocked(addTaskEvent).mock.calls[0]![3] as { importance: string }
    expect(eventArg.importance).toBe("medium")
  })

  it("skips empty lines", () => {
    const input = [
      "",
      '{"type":"task-update","content":"Valid","importance":"low"}',
      "",
      "  ",
    ].join("\n")

    const count = parseAndStoreMemoryJsonLines(input, memKey)
    expect(count).toBe(1)
  })
})
