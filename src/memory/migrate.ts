import { resolveMemoryKey } from "./resolve.js"
import {
  getLegacyMemoryFiles,
  loadLegacyMemory,
  markLegacyMigrated,
  addProjectEvent,
  addTaskEvent,
} from "./store.js"
import type { MemoryEvent } from "../types/index.js"

/**
 * Migrate legacy flat memory files (~/.ambient/memory/<hash>.json) to the
 * new two-level project/task structure. Runs once on daemon startup.
 *
 * Legacy format:
 *   { directory, lastAgent, lastActive, summary, facts[] }
 *
 * Migrates to:
 *   - summary → session-summary event in the task memory
 *   - each fact → decision event in the project memory
 */
export function migrateIfNeeded(): void {
  const legacyFiles = getLegacyMemoryFiles()
  if (legacyFiles.length === 0) return

  let migrated = 0

  for (const filePath of legacyFiles) {
    const entry = loadLegacyMemory(filePath)
    if (!entry) continue

    try {
      const key = resolveMemoryKey(entry.directory)

      // Migrate summary as a session-summary event in the task memory
      if (entry.summary) {
        const summaryEvent: MemoryEvent = {
          id: globalThis.crypto.randomUUID(),
          type: "session-summary",
          timestamp: entry.lastActive,
          content: `[Migrated from ${entry.lastAgent}] ${entry.summary}`,
          importance: "low",
        }
        addTaskEvent(key.projectKey, key.taskKey, key.branchName, summaryEvent)
      }

      // Migrate facts as decisions in the project memory
      for (const fact of entry.facts) {
        const factEvent: MemoryEvent = {
          id: globalThis.crypto.randomUUID(),
          type: "decision",
          timestamp: entry.lastActive,
          content: fact,
          importance: "medium",
        }
        addProjectEvent(key.projectKey, key.projectName, key.origin, factEvent)
      }

      markLegacyMigrated(filePath)
      migrated++
    } catch {
      // Skip files that fail to migrate
    }
  }

  if (migrated > 0) {
    process.stderr.write(`[ambient] Migrated ${migrated} legacy memory file(s) to two-level format\n`)
  }
}
