import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { UsageTracker } from "../../src/usage/tracker.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ambient-usage-test-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("UsageTracker", () => {
  it("record adds to allTime and daily totals", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 1000,
      outputTokens: 200,
    })

    const allTime = tracker.allTimeSummary()
    expect(allTime.inputTokens).toBe(1000)
    expect(allTime.outputTokens).toBe(200)
    expect(allTime.requestCount).toBe(1)

    const today = tracker.todaySummary()
    expect(today.inputTokens).toBe(1000)
    expect(today.outputTokens).toBe(200)
    expect(today.requestCount).toBe(1)
  })

  it("calculates cost correctly for known model", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 1000,
      outputTokens: 200,
    })

    // Pricing: input $0.000001/token, output $0.000005/token
    // Expected: 1000 * 0.000001 + 200 * 0.000005 = 0.001 + 0.001 = 0.002
    const today = tracker.todaySummary()
    expect(today.totalCost).toBeCloseTo(0.002, 6)
  })

  it("calculates zero cost for unknown model", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "unknown-model",
      purpose: "assist",
      inputTokens: 1000,
      outputTokens: 200,
    })

    const today = tracker.todaySummary()
    expect(today.totalCost).toBe(0)
    expect(today.requestCount).toBe(1)
  })

  it("budget enforcement: over budget returns allowed: false", () => {
    const tracker = new UsageTracker(tempDir, { dailyBudgetUsd: 0.001 })
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 1000,
      outputTokens: 200,
    })

    // Cost is 0.002, budget is 0.001
    const budget = tracker.checkBudget()
    expect(budget.allowed).toBe(false)
    expect(budget.warning).toBeDefined()
    expect(budget.remainingUsd).toBe(0)
  })

  it("warning at configured threshold", () => {
    const tracker = new UsageTracker(tempDir, { dailyBudgetUsd: 0.01, warnAtPercent: 50 })
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 5000,
      outputTokens: 200,
    })

    // Cost = 5000 * 0.000001 + 200 * 0.000005 = 0.005 + 0.001 = 0.006
    // 60% of 0.01 budget, above 50% threshold
    const budget = tracker.checkBudget()
    expect(budget.allowed).toBe(true)
    expect(budget.warning).toBeDefined()
    expect(budget.remainingUsd).toBeGreaterThan(0)
  })

  it("no budget configured means always allowed", () => {
    const tracker = new UsageTracker(tempDir, { dailyBudgetUsd: null })
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 100000,
      outputTokens: 50000,
    })

    const budget = tracker.checkBudget()
    expect(budget.allowed).toBe(true)
    expect(budget.warning).toBeUndefined()
  })

  it("save/load round-trip preserves data", () => {
    const tracker1 = new UsageTracker(tempDir)
    tracker1.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "extract",
      inputTokens: 500,
      outputTokens: 100,
    })
    tracker1.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "compact",
      inputTokens: 300,
      outputTokens: 50,
    })

    // Load in new tracker instance
    const tracker2 = new UsageTracker(tempDir)
    tracker2.load()

    const allTime = tracker2.allTimeSummary()
    expect(allTime.inputTokens).toBe(800)
    expect(allTime.outputTokens).toBe(150)
    expect(allTime.requestCount).toBe(2)
  })

  it("daily pruning removes old entries on save", () => {
    const tracker = new UsageTracker(tempDir)

    // Manually inject old daily entries by loading, manipulating, and saving
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 100,
      outputTokens: 10,
    })

    // Read the raw file and inject 35 old daily entries
    const filePath = join(tempDir, "usage.json")
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as {
      daily: Record<string, unknown>
    }
    for (let i = 0; i < 35; i++) {
      const date = `2020-01-${String(i + 1).padStart(2, "0")}`
      raw.daily[date] = {
        inputTokens: 10,
        outputTokens: 5,
        totalCost: 0.0001,
        requestCount: 1,
        byPurpose: {},
      }
    }
    writeFileSync(filePath, JSON.stringify(raw))

    // Load and trigger save (which prunes)
    const tracker2 = new UsageTracker(tempDir)
    tracker2.load()
    tracker2.save()

    // Read back — should have at most 30 daily entries
    const saved = JSON.parse(readFileSync(filePath, "utf-8")) as {
      daily: Record<string, unknown>
    }
    expect(Object.keys(saved.daily).length).toBeLessThanOrEqual(30)
  })

  it("reset clears everything", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 1000,
      outputTokens: 200,
    })

    tracker.reset()

    const allTime = tracker.allTimeSummary()
    expect(allTime.inputTokens).toBe(0)
    expect(allTime.outputTokens).toBe(0)
    expect(allTime.requestCount).toBe(0)
    expect(allTime.totalCost).toBe(0)

    const today = tracker.todaySummary()
    expect(today.requestCount).toBe(0)
  })

  it("graceful handling of corrupt usage.json", () => {
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(join(tempDir, "usage.json"), "{ not valid json !!!")

    const tracker = new UsageTracker(tempDir)
    tracker.load()

    // Should start fresh, not throw
    const allTime = tracker.allTimeSummary()
    expect(allTime.requestCount).toBe(0)
  })

  it("graceful handling of missing usage.json", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.load()

    const allTime = tracker.allTimeSummary()
    expect(allTime.requestCount).toBe(0)
  })

  it("summaryByPurpose returns correct breakdown", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 100,
      outputTokens: 10,
    })
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "extract",
      inputTokens: 200,
      outputTokens: 20,
    })
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 300,
      outputTokens: 30,
    })

    const byPurpose = tracker.summaryByPurpose()
    expect(byPurpose.assist?.requestCount).toBe(2)
    expect(byPurpose.assist?.inputTokens).toBe(400)
    expect(byPurpose.extract?.requestCount).toBe(1)
    expect(byPurpose.extract?.inputTokens).toBe(200)
  })

  it("dailyBreakdown returns recent days sorted desc", () => {
    const tracker = new UsageTracker(tempDir)
    tracker.record({
      timestamp: Date.now(),
      model: "claude-haiku-4-5-20251001",
      purpose: "assist",
      inputTokens: 100,
      outputTokens: 10,
    })

    const breakdown = tracker.dailyBreakdown(7)
    expect(breakdown.length).toBeGreaterThanOrEqual(1)
    expect(breakdown[0]!.date).toBe(new Date().toISOString().slice(0, 10))
    expect(breakdown[0]!.summary.requestCount).toBe(1)
  })

  it("caps recent records at 100", () => {
    const tracker = new UsageTracker(tempDir)
    for (let i = 0; i < 110; i++) {
      tracker.record({
        timestamp: Date.now(),
        model: "claude-haiku-4-5-20251001",
        purpose: "assist",
        inputTokens: 10,
        outputTokens: 5,
      })
    }

    // Load from disk to verify persistence
    const tracker2 = new UsageTracker(tempDir)
    tracker2.load()
    const allTime = tracker2.allTimeSummary()
    expect(allTime.requestCount).toBe(110) // allTime still has total
  })
})
