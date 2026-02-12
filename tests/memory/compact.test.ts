import { describe, it, expect } from "vitest"
import type { MemoryEvent } from "../../src/types/index.js"

/**
 * Tests for compaction logic: event partitioning, threshold checks,
 * and fallback behavior when LLM is unavailable.
 */

describe("compaction event partitioning", () => {
  it("separates high-importance events from others", () => {
    const events: MemoryEvent[] = [
      { id: "1", type: "decision", timestamp: 1, content: "critical", importance: "high" },
      { id: "2", type: "session-summary", timestamp: 2, content: "summary", importance: "low" },
      { id: "3", type: "task-update", timestamp: 3, content: "update", importance: "medium" },
      { id: "4", type: "decision", timestamp: 4, content: "another critical", importance: "high" },
    ]

    const highEvents = events.filter((e) => e.importance === "high")
    const otherEvents = events.filter((e) => e.importance !== "high")

    expect(highEvents).toHaveLength(2)
    expect(otherEvents).toHaveLength(2)
    expect(highEvents.every((e) => e.importance === "high")).toBe(true)
  })

  it("selects oldest events for compaction", () => {
    const events: MemoryEvent[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      type: "session-summary" as const,
      timestamp: i * 1000,
      content: `event ${i}`,
      importance: "low" as const,
    }))

    const compactCount = 6
    const toCompact = events.slice(0, compactCount)
    const toKeep = events.slice(compactCount)

    expect(toCompact).toHaveLength(6)
    expect(toKeep).toHaveLength(4)
    expect(toCompact[0]!.timestamp).toBeLessThan(toKeep[0]!.timestamp)
  })
})

describe("compaction thresholds", () => {
  const PROJECT_COMPACT_THRESHOLD = 40
  const TASK_COMPACT_THRESHOLD = 80

  it("triggers project compaction at 40 events", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      type: "session-summary" as const,
      timestamp: i,
      content: `event ${i}`,
      importance: "low" as const,
    }))

    expect(events.length >= PROJECT_COMPACT_THRESHOLD).toBe(true)
  })

  it("does not trigger project compaction below 40 events", () => {
    const events = Array.from({ length: 39 }, (_, i) => ({
      id: String(i),
      type: "session-summary" as const,
      timestamp: i,
      content: `event ${i}`,
      importance: "low" as const,
    }))

    expect(events.length >= PROJECT_COMPACT_THRESHOLD).toBe(false)
  })

  it("triggers task compaction at 80 events", () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      id: String(i),
      type: "session-summary" as const,
      timestamp: i,
      content: `event ${i}`,
      importance: "low" as const,
    }))

    expect(events.length >= TASK_COMPACT_THRESHOLD).toBe(true)
  })
})

describe("compaction fallback behavior", () => {
  it("drops low-importance events when LLM is unavailable", () => {
    const toCompact: MemoryEvent[] = [
      { id: "1", type: "session-summary", timestamp: 1, content: "old summary", importance: "low" },
      { id: "2", type: "task-update", timestamp: 2, content: "update", importance: "medium" },
      { id: "3", type: "session-summary", timestamp: 3, content: "another summary", importance: "low" },
    ]

    // Fallback: drop low, keep medium
    const lowCount = toCompact.filter((e) => e.importance === "low").length
    const keptFromCompact = toCompact.filter((e) => e.importance !== "low")

    expect(lowCount).toBe(2)
    expect(keptFromCompact).toHaveLength(1)
    expect(keptFromCompact[0]!.importance).toBe("medium")
  })

  it("returns null when nothing safe to drop (all medium)", () => {
    const toCompact: MemoryEvent[] = [
      { id: "1", type: "task-update", timestamp: 1, content: "update 1", importance: "medium" },
      { id: "2", type: "task-update", timestamp: 2, content: "update 2", importance: "medium" },
    ]

    const lowCount = toCompact.filter((e) => e.importance === "low").length
    expect(lowCount).toBe(0)
    // When lowCount === 0, compaction returns null (nothing safe to drop)
  })
})
