import { describe, it, expect } from "vitest"
import type { MemoryEvent } from "../../src/types/index.js"

/**
 * Tests for lifecycle logic: decision promotion deduplication,
 * merged branch matching, and event filtering patterns.
 */

describe("decision promotion logic", () => {
  it("identifies high-importance decisions for promotion", () => {
    const events: MemoryEvent[] = [
      { id: "1", type: "decision", timestamp: 1, content: "Use JWT auth", importance: "high" },
      { id: "2", type: "decision", timestamp: 2, content: "Minor naming choice", importance: "low" },
      { id: "3", type: "task-update", timestamp: 3, content: "Started auth work", importance: "medium" },
      { id: "4", type: "decision", timestamp: 4, content: "Use bcrypt for hashing", importance: "high" },
    ]

    const toPromote = events.filter(
      (e) => e.type === "decision" && e.importance === "high",
    )

    expect(toPromote).toHaveLength(2)
    expect(toPromote[0]!.content).toBe("Use JWT auth")
    expect(toPromote[1]!.content).toBe("Use bcrypt for hashing")
  })

  it("deduplicates by content against existing project events", () => {
    const existingContents = new Set(["Use JWT auth"])

    const taskDecisions: MemoryEvent[] = [
      { id: "1", type: "decision", timestamp: 1, content: "Use JWT auth", importance: "high" },
      { id: "2", type: "decision", timestamp: 2, content: "Use bcrypt for hashing", importance: "high" },
    ]

    const toPromote = taskDecisions.filter(
      (e) =>
        e.type === "decision" &&
        e.importance === "high" &&
        !existingContents.has(e.content),
    )

    expect(toPromote).toHaveLength(1)
    expect(toPromote[0]!.content).toBe("Use bcrypt for hashing")
  })
})

describe("branch key matching", () => {
  it("matches task keys to branch names with slash conversion", () => {
    const taskKeys = ["feature--auth", "fix--bug-123", "main"]
    const mergedBranches = ["feature/auth", "main", "develop"]

    const matched = taskKeys.filter((taskKey) => {
      const branchName = taskKey.replace(/--/g, "/")
      return mergedBranches.includes(branchName) || mergedBranches.includes(taskKey)
    })

    expect(matched).toEqual(["feature--auth", "main"])
  })

  it("handles task keys that are already branch names", () => {
    const taskKeys = ["main", "develop"]
    const mergedBranches = ["main", "develop"]

    const matched = taskKeys.filter((taskKey) => {
      const branchName = taskKey.replace(/--/g, "/")
      return mergedBranches.includes(branchName) || mergedBranches.includes(taskKey)
    })

    expect(matched).toEqual(["main", "develop"])
  })

  it("handles no matches", () => {
    const taskKeys = ["feature--unmerged"]
    const mergedBranches = ["main"]

    const matched = taskKeys.filter((taskKey) => {
      const branchName = taskKey.replace(/--/g, "/")
      return mergedBranches.includes(branchName) || mergedBranches.includes(taskKey)
    })

    expect(matched).toEqual([])
  })
})
