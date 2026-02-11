import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

export interface MemoryEntry {
  /** The directory this memory is associated with */
  directory: string
  /** Which agent was last used */
  lastAgent: string
  /** Timestamp of last activity */
  lastActive: number
  /** Short summary of the last session */
  summary: string
  /** Key facts about the project/conversation */
  facts: string[]
}

const MAX_SUMMARY_LENGTH = 500
const MAX_FACTS = 10
const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function getMemoryDir(): string {
  const dir = join(homedir(), ".ambient", "memory")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function hashDirectory(directory: string): string {
  return createHash("sha256").update(directory).digest("hex").slice(0, 16)
}

function getMemoryPath(directory: string): string {
  return join(getMemoryDir(), `${hashDirectory(directory)}.json`)
}

export function loadMemory(directory: string): MemoryEntry | null {
  const path = getMemoryPath(directory)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, "utf-8")
    const entry = JSON.parse(raw) as MemoryEntry

    // Skip stale memories
    if (Date.now() - entry.lastActive > MEMORY_TTL_MS) {
      return null
    }

    return entry
  } catch {
    return null
  }
}

export function saveMemory(entry: MemoryEntry): void {
  const path = getMemoryPath(entry.directory)

  // Enforce limits
  const trimmed: MemoryEntry = {
    ...entry,
    summary: entry.summary.slice(0, MAX_SUMMARY_LENGTH),
    facts: entry.facts.slice(0, MAX_FACTS),
    lastActive: Date.now(),
  }

  writeFileSync(path, JSON.stringify(trimmed, null, 2))
}

/**
 * Format memory as context for prompt injection.
 * Returns null if no relevant memory exists.
 */
export function formatMemoryForPrompt(directory: string): string | null {
  const entry = loadMemory(directory)
  if (!entry) return null

  const elapsed = Date.now() - entry.lastActive
  const timeAgo = formatTimeAgo(elapsed)

  const lines = [`Previous session (${timeAgo}, using ${entry.lastAgent}):`]
  if (entry.summary) {
    lines.push(entry.summary)
  }
  if (entry.facts.length > 0) {
    lines.push("Key context:")
    for (const fact of entry.facts) {
      lines.push(`  - ${fact}`)
    }
  }

  return lines.join("\n")
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Clean up memory files older than MEMORY_TTL_MS.
 */
export function cleanupStaleMemory(): void {
  const dir = getMemoryDir()
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue
      const path = join(dir, file)
      const stat = statSync(path)
      if (Date.now() - stat.mtimeMs > MEMORY_TTL_MS) {
        unlinkSync(path)
      }
    }
  } catch {
    // ignore cleanup errors
  }
}
