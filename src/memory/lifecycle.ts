import { execFileSync } from "node:child_process"
import {
  listTaskKeys,
  loadTaskMemory,
  addProjectEvent,
  loadProjectMemory,
  archiveTask,
} from "./store.js"
import type { MemoryEvent } from "../types/index.js"

/**
 * Detect branches that have been merged into the current branch.
 * Returns task keys that correspond to merged branches.
 */
export function detectMergedBranches(gitRoot: string, projectKey: string): string[] {
  const knownTasks = listTaskKeys(projectKey)
  if (knownTasks.length === 0) return []

  let mergedBranches: string[]
  try {
    const output = execFileSync("git", ["branch", "--merged"], {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    mergedBranches = output
      .split("\n")
      .map((b) => b.trim().replace(/^\* /, ""))
      .filter((b) => b.length > 0)
  } catch {
    return []
  }

  // Match merged branches against known task keys
  // Task keys have / replaced with -- so we need to check both forms
  return knownTasks.filter((taskKey) => {
    const branchName = taskKey.replace(/--/g, "/")
    return mergedBranches.includes(branchName) || mergedBranches.includes(taskKey)
  })
}

/**
 * Promote high-importance decisions from a task to the project level.
 * Deduplicates by checking if the content already exists in project events.
 * Returns the number of events promoted.
 */
export function promoteTaskDecisions(
  projectKey: string,
  taskKey: string,
  projectName: string,
  origin: string,
): number {
  const task = loadTaskMemory(projectKey, taskKey)
  if (!task) return 0

  const project = loadProjectMemory(projectKey)
  const existingContents = new Set(
    (project?.events ?? []).map((e) => e.content),
  )

  const toPromote = task.events.filter(
    (e) =>
      e.type === "decision" &&
      e.importance === "high" &&
      !existingContents.has(e.content),
  )

  for (const event of toPromote) {
    const promoted: MemoryEvent = {
      ...event,
      id: globalThis.crypto.randomUUID(),
      metadata: { ...event.metadata, promotedFrom: task.branchName },
    }
    addProjectEvent(projectKey, projectName, origin, promoted)
  }

  return toPromote.length
}

/**
 * Process merged branches: promote decisions, then archive.
 */
export function processMergedBranches(
  gitRoot: string,
  projectKey: string,
  projectName: string,
  origin: string,
): void {
  const merged = detectMergedBranches(gitRoot, projectKey)

  for (const taskKey of merged) {
    const promoted = promoteTaskDecisions(projectKey, taskKey, projectName, origin)
    archiveTask(projectKey, taskKey)
    if (promoted > 0) {
      process.stderr.write(
        `[ambient] Promoted ${promoted} decision(s) from ${taskKey} to project level\n`,
      )
    }
  }
}
