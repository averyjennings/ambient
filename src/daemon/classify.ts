import { addTaskEvent, addProjectEvent, isDuplicateEvent } from "../memory/store.js"
import type { MemoryKey } from "../types/index.js"

/**
 * Heuristic: does the input look like natural language rather than a shell command?
 * Mirrors the ZLE widget detection in ambient.zsh as a daemon-side safety net.
 */
export function looksLikeNaturalLanguage(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false

  const words = trimmed.split(/\s+/)

  // Single-word inputs are probably commands (or typos), not conversation
  if (words.length < 2) return false

  // Contains ? in a multi-word context — almost always natural language
  if (trimmed.includes("?")) return true

  // Starts with a conversational word (not "ambient" — that's the CLI command)
  const conversationStarters = new Set([
    "what", "how", "why", "where", "when", "who",
    "can", "could", "would", "should", "does", "did",
    "is", "are", "was", "were",
    "tell", "show", "explain", "help",
    "hey", "hi", "hello", "thanks", "thank", "please",
    "yo", "sup",
  ])
  const firstWord = (words[0] ?? "").toLowerCase()
  if (conversationStarters.has(firstWord)) return true

  // Contains contractions (apostrophes between letters) — "what's", "don't", "I'm"
  if (/[a-zA-Z]'[a-zA-Z]/.test(trimmed) && words.length >= 2) return true

  return false
}

/**
 * Classify a shell command as notable enough to persist as a memory event.
 * Returns an event type and description, or null if not worth recording.
 */
export function classifyCommand(command: string, exitCode: number): {
  type: "task-update" | "error-resolution" | "file-context"
  content: string
  importance: "low" | "medium"
} | null {
  const cmd = command.trim()
  const words = cmd.split(/\s+/)
  const base = (words[0] ?? "").toLowerCase()

  // Git operations — branch switches, commits, merges are significant
  if (base === "git") {
    const sub = (words[1] ?? "").toLowerCase()
    if (sub === "checkout" || sub === "switch") {
      const branch = words.slice(2).filter(w => !w.startsWith("-")).pop() ?? ""
      if (branch) return { type: "task-update", content: `Switched to branch: ${branch}`, importance: "medium" }
    }
    if (sub === "commit") return { type: "task-update", content: `Committed: \`${cmd.slice(0, 120)}\``, importance: "low" }
    if (sub === "merge") return { type: "task-update", content: `Merged: \`${cmd.slice(0, 120)}\``, importance: "medium" }
    if (sub === "stash") return { type: "task-update", content: `Stashed changes`, importance: "low" }
    if (sub === "rebase") return { type: "task-update", content: `Rebased: \`${cmd.slice(0, 120)}\``, importance: "medium" }
  }

  // Package manager operations
  if (base === "npm" || base === "pnpm" || base === "yarn" || base === "bun" || base === "pip" || base === "pip3" || base === "cargo") {
    const sub = (words[1] ?? "").toLowerCase()
    if (sub === "install" || sub === "add" || sub === "remove" || sub === "uninstall" || sub === "i") {
      const pkg = words.slice(2).filter(w => !w.startsWith("-")).join(" ")
      const verb = (sub === "remove" || sub === "uninstall") ? "Removed" : "Installed"
      if (pkg) return { type: "task-update", content: `${verb}: ${pkg}`, importance: "low" }
    }
  }

  // Docker/compose operations
  if (base === "docker" || base === "docker-compose") {
    const sub = (words[1] ?? "").toLowerCase()
    if (sub === "build" || sub === "up" || sub === "down" || sub === "run" || sub === "compose") {
      const status = exitCode === 0 ? "succeeded" : `failed (exit ${exitCode})`
      return { type: "task-update", content: `Docker ${words.slice(1, 4).join(" ")} ${status}`, importance: exitCode === 0 ? "low" : "medium" }
    }
  }

  // Make targets
  if (base === "make") {
    const target = words[1] ?? "default"
    if (exitCode !== 0) return { type: "error-resolution", content: `make ${target} failed (exit ${exitCode})`, importance: "medium" }
  }

  // Terraform/infrastructure
  if (base === "terraform" || base === "tf") {
    const sub = (words[1] ?? "").toLowerCase()
    if (sub === "apply" || sub === "plan" || sub === "destroy" || sub === "init") {
      const status = exitCode === 0 ? "succeeded" : `failed (exit ${exitCode})`
      return { type: "task-update", content: `terraform ${sub} ${status}`, importance: "medium" }
    }
  }

  // Build/test results — record both failures AND successes after a failure
  const isBuild = /\b(build|compile|tsc|webpack|vite|esbuild|rollup)\b/i.test(cmd)
  const isTest = /\b(test|jest|vitest|mocha|pytest|cargo\s+test|go\s+test)\b/i.test(cmd)
  const isLint = /\b(lint|eslint|prettier|clippy|ruff)\b/i.test(cmd)

  if (exitCode !== 0) {
    if (isBuild) return { type: "error-resolution", content: `Build failed: \`${cmd.slice(0, 120)}\` (exit ${exitCode})`, importance: "medium" }
    if (isTest) return { type: "error-resolution", content: `Tests failed: \`${cmd.slice(0, 120)}\` (exit ${exitCode})`, importance: "medium" }
    if (isLint) return { type: "error-resolution", content: `Lint failed: \`${cmd.slice(0, 120)}\` (exit ${exitCode})`, importance: "low" }
  } else {
    // Record build/test successes only (they indicate a fix or milestone)
    if (isBuild) return { type: "task-update", content: `Build passed: \`${cmd.slice(0, 120)}\``, importance: "low" }
    if (isTest) return { type: "task-update", content: `Tests passed: \`${cmd.slice(0, 120)}\``, importance: "low" }
  }

  // Any other non-zero exit for multi-word commands (likely real work, not typos)
  if (exitCode !== 0 && exitCode !== 127 && words.length >= 2) {
    return { type: "error-resolution", content: `Command failed: \`${cmd.slice(0, 120)}\` (exit ${exitCode})`, importance: "low" }
  }

  return null
}

/**
 * Shared helper: parse JSON-lines from Haiku, dedup, and store as memory events.
 * Used by extractAndStoreMemories and flushActivityBuffer.
 * Returns the number of events stored.
 */
export function parseAndStoreMemoryJsonLines(
  result: string,
  memKey: MemoryKey,
  options?: {
    validTypes?: readonly string[]
    metadata?: Record<string, string>
  },
): number {
  const validTypes = options?.validTypes ?? ["decision", "error-resolution", "task-update", "file-context"]
  const storedPrefixes = new Set<string>()
  let stored = 0

  for (const line of result.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue

    try {
      const item = JSON.parse(trimmed) as {
        type?: string
        content?: string
        importance?: string
      }

      if (!item.content || !item.type) continue
      if (!validTypes.includes(item.type)) continue

      const eventType = item.type as "decision" | "error-resolution" | "task-update" | "file-context"
      const importance = (["low", "medium", "high"] as const)
        .find(i => i === item.importance) ?? "medium"

      // Dedup: check against both existing events and this batch
      const prefix = item.content.slice(0, 80).toLowerCase()
      if (storedPrefixes.has(prefix)) continue
      if (isDuplicateEvent(memKey.projectKey, memKey.taskKey, item.content)) continue
      storedPrefixes.add(prefix)

      const event = {
        id: globalThis.crypto.randomUUID(),
        type: eventType,
        timestamp: Date.now(),
        content: item.content.slice(0, 1000),
        importance,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      }

      if (importance === "high") {
        addProjectEvent(memKey.projectKey, memKey.projectName, memKey.origin, event)
      }
      addTaskEvent(memKey.projectKey, memKey.taskKey, memKey.branchName, event)
      stored++
    } catch {
      // skip malformed lines
    }
  }

  return stored
}
