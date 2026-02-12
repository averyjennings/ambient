import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { MemoryEvent, MemoryKey, ProjectMemory, TaskMemory } from "../types/index.js"

// --- Legacy interface (kept for migration) ---

export interface LegacyMemoryEntry {
  directory: string
  lastAgent: string
  lastActive: number
  summary: string
  facts: string[]
}

// --- Constants ---

const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1_000 // 30 days
const MAX_PROJECT_EVENTS = 50
const MAX_TASK_EVENTS = 100

// --- Directory helpers ---

function getMemoryBaseDir(): string {
  const dir = join(homedir(), ".ambient", "memory")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getProjectDir(projectKey: string): string {
  const dir = join(getMemoryBaseDir(), "projects", projectKey)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getTasksDir(projectKey: string): string {
  const dir = join(getProjectDir(projectKey), "tasks")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getArchivedDir(projectKey: string): string {
  const dir = join(getProjectDir(projectKey), "archived")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getProjectPath(projectKey: string): string {
  return join(getProjectDir(projectKey), "project.json")
}

function getTaskPath(projectKey: string, taskKey: string): string {
  return join(getTasksDir(projectKey), `${taskKey}.json`)
}

export function getArchivedPath(projectKey: string, taskKey: string): string {
  return join(getArchivedDir(projectKey), `${taskKey}.json`)
}

// --- Project-level operations ---

export function loadProjectMemory(projectKey: string): ProjectMemory | null {
  const path = getProjectPath(projectKey)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, "utf-8")
    const memory = JSON.parse(raw) as ProjectMemory

    if (Date.now() - memory.lastActive > MEMORY_TTL_MS) {
      return null
    }
    return memory
  } catch {
    return null
  }
}

export function saveProjectMemory(memory: ProjectMemory): void {
  const path = getProjectPath(memory.projectKey)
  getProjectDir(memory.projectKey) // ensure directory exists
  writeFileSync(path, JSON.stringify(memory, null, 2))
}

export function addProjectEvent(projectKey: string, projectName: string, origin: string, event: MemoryEvent): void {
  let memory = loadProjectMemory(projectKey)

  if (!memory) {
    memory = {
      projectKey,
      projectName,
      origin,
      createdAt: Date.now(),
      lastActive: Date.now(),
      events: [],
    }
  }

  memory.events.push(event)
  memory.lastActive = Date.now()

  // Trim to limit (drop oldest low-importance events first)
  if (memory.events.length > MAX_PROJECT_EVENTS) {
    memory.events = trimEvents(memory.events, MAX_PROJECT_EVENTS)
  }

  saveProjectMemory(memory)
}

// --- Task-level operations ---

export function loadTaskMemory(projectKey: string, taskKey: string): TaskMemory | null {
  const path = getTaskPath(projectKey, taskKey)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, "utf-8")
    const memory = JSON.parse(raw) as TaskMemory

    if (Date.now() - memory.lastActive > MEMORY_TTL_MS) {
      return null
    }
    return memory
  } catch {
    return null
  }
}

export function saveTaskMemory(memory: TaskMemory): void {
  const path = getTaskPath(memory.projectKey, memory.branchKey)
  getTasksDir(memory.projectKey) // ensure directory exists
  writeFileSync(path, JSON.stringify(memory, null, 2))
}

export function addTaskEvent(
  projectKey: string,
  taskKey: string,
  branchName: string,
  event: MemoryEvent,
): void {
  let memory = loadTaskMemory(projectKey, taskKey)

  if (!memory) {
    memory = {
      branchKey: taskKey,
      branchName,
      projectKey,
      createdAt: Date.now(),
      lastActive: Date.now(),
      archived: false,
      events: [],
    }
  }

  memory.events.push(event)
  memory.lastActive = Date.now()

  if (memory.events.length > MAX_TASK_EVENTS) {
    memory.events = trimEvents(memory.events, MAX_TASK_EVENTS)
  }

  saveTaskMemory(memory)
}

// --- Merged context for prompt injection ---

/**
 * Format merged project + task memory as context for prompt injection.
 * Returns null if no relevant memory exists.
 */
export function formatMemoryForPrompt(key: MemoryKey): string | null {
  const project = loadProjectMemory(key.projectKey)
  const task = loadTaskMemory(key.projectKey, key.taskKey)

  if (!project && !task) return null

  const lines: string[] = []

  if (project && project.events.length > 0) {
    lines.push(`[Project: ${key.projectName}]`)
    const relevant = project.events
      .filter((e) => e.importance !== "low")
      .slice(-10)
    for (const event of relevant) {
      const ago = formatTimeAgo(Date.now() - event.timestamp)
      lines.push(`- ${event.content} (${event.type}, ${ago})`)
    }
  }

  if (task && task.events.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(`[Task: ${key.branchName}]`)
    const relevant = task.events.slice(-15)
    for (const event of relevant) {
      const ago = formatTimeAgo(Date.now() - event.timestamp)
      lines.push(`- ${event.content} (${event.type}, ${ago})`)
    }
  }

  return lines.length > 0 ? lines.join("\n") : null
}

// --- Lifecycle ---

export function archiveTask(projectKey: string, taskKey: string): void {
  const srcPath = getTaskPath(projectKey, taskKey)
  if (!existsSync(srcPath)) return

  const destPath = getArchivedPath(projectKey, taskKey)
  try {
    const memory = loadTaskMemory(projectKey, taskKey)
    if (memory) {
      memory.archived = true
      writeFileSync(destPath, JSON.stringify(memory, null, 2))
    }
    unlinkSync(srcPath)
  } catch {
    // ignore archive errors
  }
}

/**
 * List all task keys in a project's tasks directory.
 */
export function listTaskKeys(projectKey: string): string[] {
  const dir = join(getMemoryBaseDir(), "projects", projectKey, "tasks")
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  } catch {
    return []
  }
}

/**
 * Find the most recently active project memory across all stored projects.
 * Used as a fallback when the current cwd has no memory (e.g. parent directory).
 */
export function findMostRecentMemory(): { projectKey: string; memory: ProjectMemory } | null {
  const projectsDir = join(getMemoryBaseDir(), "projects")
  if (!existsSync(projectsDir)) return null

  let best: { projectKey: string; memory: ProjectMemory } | null = null

  try {
    for (const dir of readdirSync(projectsDir)) {
      const memory = loadProjectMemory(dir)
      if (memory && (!best || memory.lastActive > best.memory.lastActive)) {
        best = { projectKey: dir, memory }
      }
    }
  } catch {
    // ignore
  }

  return best
}

// --- Cleanup ---

/**
 * Clean up stale memory files — both legacy flat files and new project dirs.
 */
export function cleanupStaleMemory(): void {
  const baseDir = getMemoryBaseDir()

  // Clean legacy flat files (*.json in base dir)
  try {
    for (const file of readdirSync(baseDir)) {
      if (!file.endsWith(".json")) continue
      const path = join(baseDir, file)
      const stat = statSync(path)
      if (Date.now() - stat.mtimeMs > MEMORY_TTL_MS) {
        unlinkSync(path)
      }
    }
  } catch {
    // ignore
  }

  // Clean stale project dirs
  const projectsDir = join(baseDir, "projects")
  if (!existsSync(projectsDir)) return

  try {
    for (const projectDir of readdirSync(projectsDir)) {
      const projectPath = join(projectsDir, projectDir, "project.json")
      if (!existsSync(projectPath)) continue
      const stat = statSync(projectPath)
      if (Date.now() - stat.mtimeMs > MEMORY_TTL_MS) {
        // Remove entire project directory (stale)
        rmDirRecursive(join(projectsDir, projectDir))
      }
    }
  } catch {
    // ignore
  }
}

// --- Legacy support (for migration) ---

export function loadLegacyMemory(filePath: string): LegacyMemoryEntry | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const entry = JSON.parse(raw) as LegacyMemoryEntry
    // Validate it looks like the old format
    if (typeof entry.directory === "string" && typeof entry.summary === "string") {
      return entry
    }
    return null
  } catch {
    return null
  }
}

export function getLegacyMemoryFiles(): string[] {
  const baseDir = getMemoryBaseDir()
  try {
    return readdirSync(baseDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".migrated"))
      .map((f) => join(baseDir, f))
  } catch {
    return []
  }
}

export function markLegacyMigrated(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.migrated`)
  } catch {
    // ignore
  }
}

// --- Helpers ---

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Trim an event array to maxCount by removing oldest low-importance events first.
 */
function trimEvents(events: MemoryEvent[], maxCount: number): MemoryEvent[] {
  if (events.length <= maxCount) return events

  // Partition: high-importance events are protected
  const high = events.filter((e) => e.importance === "high")
  const rest = events.filter((e) => e.importance !== "high")

  // Keep all high events + newest rest events to fill remaining space
  const restBudget = maxCount - high.length
  const keptRest = restBudget > 0 ? rest.slice(-restBudget) : []

  // Re-sort by timestamp to maintain chronological order
  return [...high, ...keptRest].sort((a, b) => a.timestamp - b.timestamp)
}

function rmDirRecursive(dirPath: string): void {
  try {
    rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
