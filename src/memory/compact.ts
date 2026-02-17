import { callFastLlm } from "../assist/fast-llm.js"
import type { MemoryEvent } from "../types/index.js"
import {
  loadProjectMemory,
  saveProjectMemory,
  loadTaskMemory,
  saveTaskMemory,
} from "./store.js"

const PROJECT_COMPACT_THRESHOLD = 150  // compact at 150/200
const TASK_COMPACT_THRESHOLD = 400     // compact at 400/500

/**
 * Check if project events need compaction and run it if so.
 * Runs asynchronously — call with setTimeout(0) to avoid blocking.
 */
export async function compactProjectIfNeeded(projectKey: string): Promise<void> {
  const memory = loadProjectMemory(projectKey)
  if (!memory || memory.events.length < PROJECT_COMPACT_THRESHOLD) return

  const compacted = await compactEvents(
    memory.events,
    `project: ${memory.projectName}`,
    120, // compact oldest 120
  )
  if (!compacted) return

  memory.events = compacted
  saveProjectMemory(memory)
}

/**
 * Check if task events need compaction and run it if so.
 */
export async function compactTaskIfNeeded(projectKey: string, taskKey: string): Promise<void> {
  const memory = loadTaskMemory(projectKey, taskKey)
  if (!memory || memory.events.length < TASK_COMPACT_THRESHOLD) return

  const compacted = await compactEvents(
    memory.events,
    `task: ${memory.branchName}`,
    300, // compact oldest 300
  )
  if (!compacted) return

  memory.events = compacted
  saveTaskMemory(memory)
}

/**
 * Compact the oldest low/medium-importance events into a summary.
 * High-importance events are never compacted.
 *
 * Returns the new events array, or null if compaction failed.
 */
async function compactEvents(
  events: MemoryEvent[],
  contextLabel: string,
  compactCount: number,
): Promise<MemoryEvent[] | null> {
  // Separate high-importance events (protected)
  const highEvents = events.filter((e) => e.importance === "high")
  const otherEvents = events.filter((e) => e.importance !== "high")

  if (otherEvents.length < compactCount) return null

  // Select oldest events for compaction
  const toCompact = otherEvents.slice(0, compactCount)
  const toKeep = otherEvents.slice(compactCount)

  // Try LLM summarization
  const summaryText = await summarizeEvents(toCompact, contextLabel)

  if (summaryText) {
    const summaryEvent: MemoryEvent = {
      id: globalThis.crypto.randomUUID(),
      type: "session-summary",
      timestamp: Date.now(),
      content: summaryText,
      importance: "medium",
      metadata: { compacted: String(toCompact.length) },
    }
    return [...highEvents, summaryEvent, ...toKeep].sort(
      (a, b) => a.timestamp - b.timestamp,
    )
  }

  // Fallback: just drop the oldest low-importance events (no LLM)
  const lowCount = toCompact.filter((e) => e.importance === "low").length
  const keptFromCompact = toCompact.filter((e) => e.importance !== "low")

  if (lowCount > 0) {
    return [...highEvents, ...keptFromCompact, ...toKeep].sort(
      (a, b) => a.timestamp - b.timestamp,
    )
  }

  return null // nothing safe to drop
}

/**
 * Use Haiku to summarize a batch of memory events into a concise paragraph.
 */
async function summarizeEvents(
  events: MemoryEvent[],
  contextLabel: string,
): Promise<string | null> {
  const formatted = events
    .map((e) => `- [${e.type}] ${e.content}`)
    .join("\n")

  const prompt = `Summarize these memory events from ${contextLabel} into a concise paragraph (max 200 words). Preserve all important decisions and error resolutions. Focus on what matters for continuing work.

Events:
${formatted}

Output only the summary paragraph, nothing else.`

  return callFastLlm(prompt, undefined, undefined, "compact")
}
