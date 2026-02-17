import { writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"

export type UsagePurpose = "assist" | "extract" | "compact" | "flush"

export interface UsageRecord {
  readonly timestamp: number
  readonly model: string
  readonly purpose: UsagePurpose
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  totalCost: number
  requestCount: number
}

interface UsageData {
  version: 1
  allTime: UsageSummary
  daily: Record<string, UsageSummary & { byPurpose: Partial<Record<UsagePurpose, UsageSummary>> }>
  recentRecords: UsageRecord[]
}

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.000001, output: 0.000005 },
}

const MAX_RECENT_RECORDS = 100
const MAX_DAILY_ENTRIES = 30

function getDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function emptySummary(): UsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalCost: 0, requestCount: 0 }
}

function emptyData(): UsageData {
  return {
    version: 1,
    allTime: emptySummary(),
    daily: {},
    recentRecords: [],
  }
}

function addToSummary(summary: UsageSummary, inputTokens: number, outputTokens: number, cost: number): void {
  summary.inputTokens += inputTokens
  summary.outputTokens += outputTokens
  summary.totalCost += cost
  summary.requestCount += 1
}

export class UsageTracker {
  private data: UsageData
  private filePath: string
  private dailyBudgetUsd: number | null
  private warnAtPercent: number

  constructor(ambientDir: string, options?: { dailyBudgetUsd?: number | null; warnAtPercent?: number }) {
    this.filePath = join(ambientDir, "usage.json")
    this.dailyBudgetUsd = options?.dailyBudgetUsd ?? null
    this.warnAtPercent = options?.warnAtPercent ?? 80
    this.data = emptyData()
  }

  record(entry: {
    timestamp: number
    model: string
    purpose: UsagePurpose
    inputTokens: number
    outputTokens: number
  }): void {
    const pricing = PRICING[entry.model]
    const cost = pricing
      ? entry.inputTokens * pricing.input + entry.outputTokens * pricing.output
      : 0

    const record: UsageRecord = {
      timestamp: entry.timestamp,
      model: entry.model,
      purpose: entry.purpose,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: cost,
    }

    // Update all-time totals
    addToSummary(this.data.allTime, entry.inputTokens, entry.outputTokens, cost)

    // Update daily totals
    const dateKey = getDateKey()
    let daily = this.data.daily[dateKey]
    if (!daily) {
      daily = { ...emptySummary(), byPurpose: {} }
      this.data.daily[dateKey] = daily
    }
    addToSummary(daily, entry.inputTokens, entry.outputTokens, cost)

    // Update per-purpose within the day
    let purposeSummary = daily.byPurpose[entry.purpose]
    if (!purposeSummary) {
      purposeSummary = emptySummary()
      daily.byPurpose[entry.purpose] = purposeSummary
    }
    addToSummary(purposeSummary, entry.inputTokens, entry.outputTokens, cost)

    // Append to recent records, cap at MAX_RECENT_RECORDS
    this.data.recentRecords.push(record)
    if (this.data.recentRecords.length > MAX_RECENT_RECORDS) {
      this.data.recentRecords = this.data.recentRecords.slice(-MAX_RECENT_RECORDS)
    }

    this.save()
  }

  checkBudget(): { allowed: boolean; warning?: string; remainingUsd?: number } {
    if (this.dailyBudgetUsd === null || this.dailyBudgetUsd <= 0) {
      return { allowed: true }
    }

    const today = this.todaySummary()
    const remaining = this.dailyBudgetUsd - today.totalCost

    if (remaining <= 0) {
      return {
        allowed: false,
        warning: `Daily budget of $${this.dailyBudgetUsd.toFixed(2)} exceeded. Spent: $${today.totalCost.toFixed(4)}`,
        remainingUsd: 0,
      }
    }

    const usedPercent = (today.totalCost / this.dailyBudgetUsd) * 100
    if (usedPercent >= this.warnAtPercent) {
      return {
        allowed: true,
        warning: `${usedPercent.toFixed(0)}% of daily budget used ($${today.totalCost.toFixed(4)} / $${this.dailyBudgetUsd.toFixed(2)})`,
        remainingUsd: remaining,
      }
    }

    return { allowed: true, remainingUsd: remaining }
  }

  todaySummary(): UsageSummary {
    const dateKey = getDateKey()
    const daily = this.data.daily[dateKey]
    if (!daily) return emptySummary()
    return {
      inputTokens: daily.inputTokens,
      outputTokens: daily.outputTokens,
      totalCost: daily.totalCost,
      requestCount: daily.requestCount,
    }
  }

  allTimeSummary(): UsageSummary {
    return { ...this.data.allTime }
  }

  summaryByPurpose(): Partial<Record<UsagePurpose, UsageSummary>> {
    const dateKey = getDateKey()
    const daily = this.data.daily[dateKey]
    if (!daily) return {}

    const result: Partial<Record<UsagePurpose, UsageSummary>> = {}
    for (const [purpose, summary] of Object.entries(daily.byPurpose)) {
      result[purpose as UsagePurpose] = { ...summary }
    }
    return result
  }

  dailyBreakdown(days: number): Array<{ date: string; summary: UsageSummary }> {
    const entries = Object.entries(this.data.daily)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, days)

    return entries.map(([date, daily]) => ({
      date,
      summary: {
        inputTokens: daily.inputTokens,
        outputTokens: daily.outputTokens,
        totalCost: daily.totalCost,
        requestCount: daily.requestCount,
      },
    }))
  }

  save(): void {
    // Prune old daily entries
    const dailyKeys = Object.keys(this.data.daily).sort()
    if (dailyKeys.length > MAX_DAILY_ENTRIES) {
      const toRemove = dailyKeys.slice(0, dailyKeys.length - MAX_DAILY_ENTRIES)
      for (const key of toRemove) {
        delete this.data.daily[key]
      }
    }

    // Atomic write: write to .tmp then rename
    const tmpPath = this.filePath + ".tmp"
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2))
      renameSync(tmpPath, this.filePath)
    } catch {
      // Best-effort: if rename fails, try direct write
      try {
        writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
      } catch {
        // Silently fail — usage tracking should never break the main flow
      }
    }
  }

  load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as UsageData
      if (parsed.version === 1 && parsed.allTime && parsed.daily && parsed.recentRecords) {
        this.data = parsed
      } else {
        this.data = emptyData()
      }
    } catch {
      // Missing or corrupt file — start fresh
      this.data = emptyData()
    }
  }

  reset(): void {
    this.data = emptyData()
    this.save()
  }
}
