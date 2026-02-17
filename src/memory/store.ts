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

const MEMORY_TTL_MS = 90 * 24 * 60 * 60 * 1_000 // 90 days
const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1_000 // 7 days
const MAX_PROJECT_EVENTS = 200
const MAX_TASK_EVENTS = 500
const MAX_CONTENT_LENGTH = 1000

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

  // Supersede detection: if a new decision overlaps with an existing one, replace it
  if (event.type === "decision") {
    const supersededId = findSupersededDecision(memory.events, event.content)
    if (supersededId) {
      memory.events = memory.events.filter((e) => e.id !== supersededId)
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

  // Supersede detection: if a new decision overlaps with an existing one, replace it
  if (event.type === "decision") {
    const supersededId = findSupersededDecision(memory.events, event.content)
    if (supersededId) {
      memory.events = memory.events.filter((e) => e.id !== supersededId)
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

// Stop words to ignore when extracting search keywords
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "me", "my", "you", "your", "we", "our", "they", "them", "their",
  "it", "its", "he", "she", "him", "her", "his", "this", "that", "these",
  "those", "what", "which", "who", "whom", "where", "when", "how", "why",
  "and", "or", "but", "not", "no", "if", "then", "else", "so", "than",
  "too", "very", "just", "about", "above", "after", "again", "all", "also",
  "am", "any", "as", "at", "back", "because", "before", "between", "both",
  "by", "came", "come", "each", "even", "for", "from", "get", "got",
  "go", "going", "here", "in", "into", "know", "let", "like", "look",
  "make", "many", "more", "most", "much", "of", "on", "only", "other",
  "out", "over", "re", "really", "right", "said", "same", "see", "some",
  "still", "such", "take", "tell", "through", "to", "up", "us", "use",
  "want", "way", "well", "were", "with", "yes", "yet",
  "remember", "memories", "memory", "everything", "anything", "something",
  "hey", "hi", "hello", "please", "thanks",
])

/**
 * Extract meaningful keywords from text for search and similarity.
 */
export function extractKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
}

// --- Decision dedup (supersede detection) ---

/**
 * Jaccard similarity between two keyword sets: |intersection| / |union|.
 * Returns 0 if either set is empty.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

const SUPERSEDE_THRESHOLD = 0.4

/**
 * Find an existing decision event that the new decision supersedes.
 * Uses Jaccard keyword similarity — if an existing decision shares >40% of
 * keywords with the new one, it's considered superseded (same topic, evolved conclusion).
 *
 * Returns the event ID of the most similar superseded decision, or null.
 * Only compares against "decision" type events.
 */
export function findSupersededDecision(events: readonly MemoryEvent[], newContent: string): string | null {
  const newKeywords = new Set(extractKeywords(newContent))
  if (newKeywords.size < 2) return null // too few keywords to compare reliably

  let bestId: string | null = null
  let bestScore = 0

  for (const event of events) {
    if (event.type !== "decision") continue
    const existingKeywords = new Set(extractKeywords(event.content))
    const similarity = jaccardSimilarity(newKeywords, existingKeywords)
    if (similarity > SUPERSEDE_THRESHOLD && similarity > bestScore) {
      bestScore = similarity
      bestId = event.id
    }
  }

  return bestId
}

/**
 * Check if similar content already exists in recent task events.
 * Uses prefix match on the first 80 characters (case-insensitive).
 * Prevents duplicate memories across multiple extraction paths.
 */
export function isDuplicateEvent(projectKey: string, taskKey: string, content: string): boolean {
  const task = loadTaskMemory(projectKey, taskKey)
  if (!task || task.events.length === 0) return false

  const prefix = content.slice(0, 80).toLowerCase()
  const recent = task.events.slice(-20)
  return recent.some(e => e.content.slice(0, 80).toLowerCase() === prefix)
}

// --- TF-IDF scoring ---

interface ScoredEvent {
  event: MemoryEvent
  source: string
  searchText: string
  score: number
  _recency: number
  _tfidf: number
}

/**
 * Compute IDF (inverse document frequency) for each keyword across a corpus.
 * Uses smoothed IDF: log((1 + N) / (1 + df)) to handle small corpora.
 * Ensures even terms appearing in all documents get a small positive weight.
 */
function computeIdf(searchTexts: string[], keywords: string[]): Map<string, number> {
  const idf = new Map<string, number>()
  const n = searchTexts.length

  for (const kw of keywords) {
    let df = 0
    for (const text of searchTexts) {
      if (text.includes(kw)) df++
    }
    idf.set(kw, Math.log((1 + n) / (1 + df)))
  }

  return idf
}

/**
 * Score an event using TF-IDF against search keywords.
 * searchText should include projectName + branchName + event.content.
 */
function scoreTfIdf(searchText: string, keywords: string[], idfMap: Map<string, number>): number {
  if (keywords.length === 0) return 0
  let score = 0
  for (const kw of keywords) {
    if (searchText.includes(kw)) {
      score += idfMap.get(kw) ?? 0
    }
  }
  return score
}

/**
 * Compute a recency score using exponential decay.
 * Returns ~1.0 for events from now, ~0.5 for 24h ago, ~0.01 for a week ago.
 */
function recencyScore(timestamp: number): number {
  const hoursAgo = (Date.now() - timestamp) / (1_000 * 60 * 60)
  return 1 / (1 + hoursAgo / 24)
}

/**
 * Search memory for events relevant to a query, with fallback to recent events.
 * Returns formatted memory string for prompt injection.
 * Used by the assist handler to inject contextually relevant memories.
 */
/**
 * Search memory for events relevant to a query within a single project.
 * Now uses TF-IDF scoring. For cross-project search, use searchAllMemory().
 */
export function searchMemoryForPrompt(key: MemoryKey, query: string, maxEvents = 30): string | null {
  const project = loadProjectMemory(key.projectKey)
  const task = loadTaskMemory(key.projectKey, key.taskKey)

  if (!project && !task) return null

  // Collect all events with searchable text
  const items: { event: MemoryEvent; source: string; searchText: string }[] = []

  if (project) {
    for (const e of project.events) {
      items.push({
        event: e,
        source: `Project: ${key.projectName}`,
        searchText: `${key.projectName} ${e.content}`.toLowerCase(),
      })
    }
  }
  if (task) {
    for (const e of task.events) {
      items.push({
        event: e,
        source: `Task: ${key.branchName}`,
        searchText: `${key.projectName} ${key.branchName} ${e.content}`.toLowerCase(),
      })
    }
  }

  if (items.length === 0) return null

  const keywords = extractKeywords(query)
  const searchTexts = items.map((it) => it.searchText)
  const idfMap = keywords.length > 0 ? computeIdf(searchTexts, keywords) : new Map<string, number>()

  // Score with TF-IDF + recency (adaptive weighting)
  const scored = items.map((item) => {
    const rec = recencyScore(item.event.timestamp)
    let tfidf = scoreTfIdf(item.searchText, keywords, idfMap)
    if (item.event.importance === "high") tfidf *= 1.5
    return { ...item, _recency: rec, _tfidf: tfidf, score: 0 }
  })

  const maxTfidf = Math.max(...scored.map((s) => s._tfidf), 0.001)
  const hasKeywords = keywords.length > 0

  for (const s of scored) {
    const norm = s._tfidf / maxTfidf
    s.score = hasKeywords ? 0.5 * s._recency + 0.5 * norm : s._recency
  }

  scored.sort((a, b) => b.score - a.score)
  const selected = scored.slice(0, maxEvents)

  // Format output
  const lines: string[] = []
  let currentSource = ""
  selected.sort((a, b) => a.event.timestamp - b.event.timestamp)

  for (const { event, source } of selected) {
    if (source !== currentSource) {
      if (lines.length > 0) lines.push("")
      lines.push(`[${source}]`)
      currentSource = source
    }
    const ago = formatTimeAgo(Date.now() - event.timestamp)
    lines.push(`- ${event.content} (${event.type}, ${ago})`)
  }

  return lines.length > 0 ? lines.join("\n") : null
}

// --- Cross-project search ---

/**
 * Delete a memory event by ID from both project and task stores.
 * Returns true if the event was found and removed.
 */
export function deleteMemoryEvent(memKey: MemoryKey, eventId: string): boolean {
  let found = false

  const project = loadProjectMemory(memKey.projectKey)
  if (project) {
    const before = project.events.length
    project.events = project.events.filter((e) => e.id !== eventId)
    if (project.events.length < before) {
      found = true
      saveProjectMemory(project)
    }
  }

  const task = loadTaskMemory(memKey.projectKey, memKey.taskKey)
  if (task) {
    const before = task.events.length
    task.events = task.events.filter((e) => e.id !== eventId)
    if (task.events.length < before) {
      found = true
      saveTaskMemory(task)
    }
  }

  return found
}

/**
 * Update a memory event's content by ID. Searches both project and task stores.
 * Returns true if the event was found and updated.
 */
export function updateMemoryEvent(memKey: MemoryKey, eventId: string, newContent: string): boolean {
  let found = false
  const truncated = newContent.slice(0, MAX_CONTENT_LENGTH)

  const project = loadProjectMemory(memKey.projectKey)
  if (project) {
    const idx = project.events.findIndex((e) => e.id === eventId)
    if (idx !== -1) {
      found = true
      project.events = project.events.map((e) =>
        e.id === eventId ? { ...e, content: truncated } : e,
      )
      project.lastActive = Date.now()
      saveProjectMemory(project)
    }
  }

  const task = loadTaskMemory(memKey.projectKey, memKey.taskKey)
  if (task) {
    const idx = task.events.findIndex((e) => e.id === eventId)
    if (idx !== -1) {
      found = true
      task.events = task.events.map((e) =>
        e.id === eventId ? { ...e, content: truncated } : e,
      )
      task.lastActive = Date.now()
      saveTaskMemory(task)
    }
  }

  return found
}

/**
 * List all project keys in the memory directory.
 */
export function listAllProjects(): string[] {
  const projectsDir = join(getMemoryBaseDir(), "projects")
  if (!existsSync(projectsDir)) return []
  try {
    return readdirSync(projectsDir).filter((d) => {
      const projPath = join(projectsDir, d, "project.json")
      return existsSync(projPath)
    })
  } catch {
    return []
  }
}

/**
 * Search ALL projects and branches for events relevant to a query.
 * Uses TF-IDF for keyword relevance + exponential decay for recency.
 * Adaptive weighting: keyword-heavy queries lean on TF-IDF, vague queries lean on recency.
 *
 * Returns formatted memory string with source labels, or null if no memory exists.
 */
export function searchAllMemory(query: string, maxEvents = 50): string | null {
  const projectKeys = listAllProjects()
  if (projectKeys.length === 0) return null

  // 1. Collect all events across all projects and branches
  const items: { event: MemoryEvent; projectName: string; branchName: string }[] = []

  for (const pk of projectKeys) {
    const project = loadProjectMemory(pk)
    if (!project) continue

    // Project-level events
    for (const e of project.events) {
      items.push({ event: e, projectName: project.projectName, branchName: "" })
    }

    // Task-level events (all branches)
    const taskKeys = listTaskKeys(pk)
    for (const tk of taskKeys) {
      const task = loadTaskMemory(pk, tk)
      if (!task) continue
      for (const e of task.events) {
        items.push({ event: e, projectName: project.projectName, branchName: task.branchName })
      }
    }
  }

  if (items.length === 0) return null

  // 2. Build searchable text for each event (includes project + branch names)
  const searchTexts = items.map(
    (it) => `${it.projectName} ${it.branchName} ${it.event.content}`.toLowerCase(),
  )

  // 3. Extract keywords and compute IDF
  const keywords = extractKeywords(query)
  const idfMap = keywords.length > 0 ? computeIdf(searchTexts, keywords) : new Map<string, number>()

  // 4. Score each event
  const scored: ScoredEvent[] = items.map((item, i) => {
    const recency = recencyScore(item.event.timestamp)
    const tfidf = scoreTfIdf(searchTexts[i]!, keywords, idfMap)

    // Boost high-importance events
    const boostedTfidf = item.event.importance === "high" ? tfidf * 1.5 : tfidf

    return {
      event: item.event,
      source: item.branchName
        ? `${item.projectName} (${item.branchName})`
        : item.projectName,
      searchText: searchTexts[i]!,
      score: 0, // computed below
      _recency: recency,
      _tfidf: boostedTfidf,
    }
  })

  // 5. Normalize TF-IDF scores to 0-1 range
  const maxTfidf = Math.max(...scored.map((s) => s._tfidf), 0.001)

  // 6. Adaptive weighting: if keywords exist, balance; otherwise pure recency
  const hasKeywords = keywords.length > 0
  for (const s of scored) {
    const normalizedTfidf = s._tfidf / maxTfidf
    s.score = hasKeywords
      ? 0.5 * s._recency + 0.5 * normalizedTfidf
      : s._recency
  }

  // 7. Sort by score, take top N
  scored.sort((a, b) => b.score - a.score)
  const selected = scored.slice(0, maxEvents)

  if (selected.length === 0) return null

  // 8. Format output grouped by source, sorted chronologically within groups
  const groups = new Map<string, ScoredEvent[]>()
  for (const s of selected) {
    const existing = groups.get(s.source) ?? []
    existing.push(s)
    groups.set(s.source, existing)
  }

  const lines: string[] = []
  for (const [source, events] of groups) {
    if (lines.length > 0) lines.push("")
    lines.push(`[${source}]`)
    events.sort((a, b) => a.event.timestamp - b.event.timestamp)
    for (const { event } of events) {
      const ago = formatTimeAgo(Date.now() - event.timestamp)
      lines.push(`- ${event.content} (${event.type}, ${ago})`)
    }
  }

  return lines.length > 0 ? lines.join("\n") : null
}

// --- Cross-session activity feed ---

/**
 * Get recent memory events across ALL projects and branches, sorted by time.
 * No query required — pure recency. Lets agents quickly see what other
 * sessions/projects have been working on.
 */
export function getRecentActivity(maxEvents = 30): string | null {
  const projectKeys = listAllProjects()
  if (projectKeys.length === 0) return null

  const items: { event: MemoryEvent; projectName: string; branchName: string }[] = []

  for (const pk of projectKeys) {
    const project = loadProjectMemory(pk)
    if (!project) continue

    for (const e of project.events) {
      items.push({ event: e, projectName: project.projectName, branchName: "" })
    }

    const taskKeys = listTaskKeys(pk)
    for (const tk of taskKeys) {
      const task = loadTaskMemory(pk, tk)
      if (!task) continue
      for (const e of task.events) {
        items.push({ event: e, projectName: project.projectName, branchName: task.branchName })
      }
    }
  }

  if (items.length === 0) return null

  // Sort by timestamp descending (most recent first)
  items.sort((a, b) => b.event.timestamp - a.event.timestamp)
  const selected = items.slice(0, maxEvents)

  const lines: string[] = []
  for (const { event, projectName, branchName } of selected) {
    const source = branchName ? `${projectName} (${branchName})` : projectName
    const ago = formatTimeAgo(Date.now() - event.timestamp)
    lines.push(`[${source}] ${event.content} (${event.type}, ${ago})`)
  }

  return lines.join("\n")
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
        continue
      }

      // Clean stale archived branch files (7-day TTL)
      const archivedDir = join(projectsDir, projectDir, "archived")
      if (existsSync(archivedDir)) {
        try {
          for (const file of readdirSync(archivedDir)) {
            if (!file.endsWith(".json")) continue
            const filePath = join(archivedDir, file)
            const fileStat = statSync(filePath)
            if (Date.now() - fileStat.mtimeMs > ARCHIVE_TTL_MS) {
              unlinkSync(filePath)
            }
          }
        } catch {
          // ignore
        }
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
  // After 24h, show the actual date so agents can reference exact times
  const date = new Date(Date.now() - ms)
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    + " " + date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
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
