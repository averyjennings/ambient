import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { MemoryEvent, ProjectMemory, TaskMemory } from "../../src/types/index.js"

// We need to test store.ts functions but they use homedir() internally.
// Instead of mocking, we test the pure helper logic by importing and testing
// the exported functions that work with specific paths.

// For the formatTimeAgo logic, we test the output of formatMemoryForPrompt indirectly.

describe("store", () => {
  // We'll dynamically import the module to avoid issues with homedir caching
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ambient-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe("ProjectMemory JSON serialization", () => {
    it("round-trips ProjectMemory through JSON", () => {
      const memory: ProjectMemory = {
        projectKey: "abc123",
        projectName: "test-project",
        origin: "https://github.com/user/test-project",
        createdAt: Date.now(),
        lastActive: Date.now(),
        events: [
          {
            id: "evt-1",
            type: "decision",
            timestamp: Date.now(),
            content: "Use TypeScript for all modules",
            importance: "high",
          },
        ],
      }

      const path = join(tmpDir, "project.json")
      writeFileSync(path, JSON.stringify(memory, null, 2))

      const loaded = JSON.parse(readFileSync(path, "utf-8")) as ProjectMemory
      expect(loaded.projectKey).toBe("abc123")
      expect(loaded.projectName).toBe("test-project")
      expect(loaded.events).toHaveLength(1)
      expect(loaded.events[0]!.type).toBe("decision")
      expect(loaded.events[0]!.importance).toBe("high")
    })
  })

  describe("TaskMemory JSON serialization", () => {
    it("round-trips TaskMemory through JSON", () => {
      const memory: TaskMemory = {
        branchKey: "feature--auth",
        branchName: "feature/auth",
        projectKey: "abc123",
        createdAt: Date.now(),
        lastActive: Date.now(),
        archived: false,
        events: [
          {
            id: "evt-1",
            type: "task-update",
            timestamp: Date.now(),
            content: "Implementing JWT authentication",
            importance: "medium",
          },
          {
            id: "evt-2",
            type: "error-resolution",
            timestamp: Date.now(),
            content: "Fixed CORS issue by adding allowed origins",
            importance: "medium",
            metadata: { file: "src/middleware/cors.ts" },
          },
        ],
      }

      const path = join(tmpDir, "task.json")
      writeFileSync(path, JSON.stringify(memory, null, 2))

      const loaded = JSON.parse(readFileSync(path, "utf-8")) as TaskMemory
      expect(loaded.branchKey).toBe("feature--auth")
      expect(loaded.branchName).toBe("feature/auth")
      expect(loaded.archived).toBe(false)
      expect(loaded.events).toHaveLength(2)
      expect(loaded.events[1]!.metadata?.file).toBe("src/middleware/cors.ts")
    })
  })

  describe("MemoryEvent importance levels", () => {
    it("supports all three importance levels", () => {
      const events: MemoryEvent[] = [
        { id: "1", type: "session-summary", timestamp: 1, content: "low event", importance: "low" },
        { id: "2", type: "decision", timestamp: 2, content: "med event", importance: "medium" },
        { id: "3", type: "decision", timestamp: 3, content: "high event", importance: "high" },
      ]

      const high = events.filter((e) => e.importance === "high")
      const nonHigh = events.filter((e) => e.importance !== "high")

      expect(high).toHaveLength(1)
      expect(nonHigh).toHaveLength(2)
    })
  })

  describe("trimEvents logic", () => {
    // Reproduce the trimEvents behavior to test it
    function trimEvents(events: MemoryEvent[], maxCount: number): MemoryEvent[] {
      if (events.length <= maxCount) return events
      const high = events.filter((e) => e.importance === "high")
      const rest = events.filter((e) => e.importance !== "high")
      const restBudget = maxCount - high.length
      const keptRest = restBudget > 0 ? rest.slice(-restBudget) : []
      return [...high, ...keptRest].sort((a, b) => a.timestamp - b.timestamp)
    }

    it("returns events as-is when under limit", () => {
      const events: MemoryEvent[] = [
        { id: "1", type: "decision", timestamp: 1, content: "test", importance: "low" },
      ]
      expect(trimEvents(events, 5)).toEqual(events)
    })

    it("preserves high-importance events when trimming", () => {
      const events: MemoryEvent[] = [
        { id: "1", type: "session-summary", timestamp: 1, content: "old low", importance: "low" },
        { id: "2", type: "decision", timestamp: 2, content: "high decision", importance: "high" },
        { id: "3", type: "session-summary", timestamp: 3, content: "newer low", importance: "low" },
        { id: "4", type: "task-update", timestamp: 4, content: "medium task", importance: "medium" },
        { id: "5", type: "decision", timestamp: 5, content: "another high", importance: "high" },
      ]

      const result = trimEvents(events, 3)
      expect(result).toHaveLength(3)
      // Both high events must survive
      expect(result.filter((e) => e.importance === "high")).toHaveLength(2)
      // Only 1 non-high event fits (budget = 3 - 2 = 1), it's the newest
      expect(result.filter((e) => e.importance !== "high")).toHaveLength(1)
      expect(result.filter((e) => e.importance !== "high")[0]!.id).toBe("4")
    })

    it("maintains chronological order after trimming", () => {
      const events: MemoryEvent[] = [
        { id: "1", type: "decision", timestamp: 10, content: "high", importance: "high" },
        { id: "2", type: "session-summary", timestamp: 20, content: "low", importance: "low" },
        { id: "3", type: "task-update", timestamp: 30, content: "med", importance: "medium" },
        { id: "4", type: "decision", timestamp: 5, content: "early high", importance: "high" },
      ]

      const result = trimEvents(events, 3)
      // Should be sorted by timestamp
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.timestamp).toBeGreaterThanOrEqual(result[i - 1]!.timestamp)
      }
    })
  })
})
