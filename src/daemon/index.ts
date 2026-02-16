#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { ContextEngine } from "../context/engine.js"
import { routeToAgent } from "../agents/router.js"
import { detectAvailableAgents, builtinAgents } from "../agents/registry.js"
import { selectAgent } from "../agents/selector.js"
import { getSocketPath, getPidPath } from "../config.js"
import type {
  ActivityFlushPayload,
  ActivityPayload,
  AssistPayload,
  CapturePayload,
  ComparePayload,
  ContextReadPayload,
  ContextUpdatePayload,
  DaemonRequest,
  DaemonResponse,
  MemoryKey,
  MemoryDeletePayload,
  MemoryReadPayload,
  MemorySearchPayload,
  MemoryStorePayload,
  MemoryUpdatePayload,
  NewSessionPayload,
  QueryPayload,
  SessionState,
} from "../types/index.js"
import { loadConfig } from "../config.js"
import { formatMemoryForPrompt, searchAllMemory, addTaskEvent, addProjectEvent, cleanupStaleMemory, loadTaskMemory, deleteMemoryEvent, updateMemoryEvent } from "../memory/store.js"
import { resolveMemoryKey, resolveGitRoot } from "../memory/resolve.js"
import { migrateIfNeeded } from "../memory/migrate.js"
import { streamFastLlm, callFastLlm } from "../assist/fast-llm.js"
import { ContextFileGenerator } from "../memory/context-file.js"
import { compactProjectIfNeeded, compactTaskIfNeeded } from "../memory/compact.js"
import { processMergedBranches } from "../memory/lifecycle.js"
import { ensureAmbientInstructions, ensureProjectInstructions } from "../setup/claude-md.js"
import { ensureClaudeHooks } from "../setup/claude-hooks.js"

const context = new ContextEngine()
const contextFileGen = new ContextFileGenerator()

// Per-branch session state — keyed by "projectKey:taskKey"
const sessions = new Map<string, SessionState>()
const sessionMemoryKeys = new Map<string, MemoryKey>()

// --- Passive activity monitoring ---

interface ActivityEntry {
  tool: string
  filePath?: string
  command?: string
  description?: string
  timestamp: number
}

const activityBuffers = new Map<string, ActivityEntry[]>()
const ACTIVITY_FLUSH_THRESHOLD = 30
const ACTIVITY_BUFFER_MAX = 50
const ACTIVITY_MIN_FOR_EXTRACTION = 3

// Track project dirs where we've already ensured instruction files
const instructionsDirs = new Set<string>()

// Suppress repeated API key warnings
let apiKeyWarned = false

// Ring buffer of recent assist interactions so ambient remembers what it said
interface AssistEntry {
  readonly command: string
  readonly exitCode: number
  readonly response: string
  readonly timestamp: number
}
const recentAssists: AssistEntry[] = []
const MAX_RECENT_ASSISTS = 5

// Cache of available agents (detected on startup)
let availableAgents: string[] = []

function sessionKeyFromMemoryKey(key: MemoryKey): string {
  return `${key.projectKey}:${key.taskKey}`
}

/**
 * Save a session's last response as a memory event for the current task.
 */
function persistSessionMemory(key: MemoryKey, session: SessionState): void {
  if (!session.lastResponse || session.queryCount < 1) return

  const summary = session.lastResponse.slice(0, 1000).trimEnd()

  addTaskEvent(key.projectKey, key.taskKey, key.branchName, {
    id: globalThis.crypto.randomUUID(),
    type: "session-summary",
    timestamp: Date.now(),
    content: summary,
    importance: "low",
  })
  log("info", `Saved memory for ${key.projectName}:${key.branchName}`)
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] [${level}] ${msg}\n`)
}

function sendResponse(socket: import("node:net").Socket, response: DaemonResponse): void {
  const line = JSON.stringify(response) + "\n"
  socket.write(line)
}

/**
 * Heuristic: does the input look like natural language rather than a shell command?
 * Mirrors the ZLE widget detection in ambient.zsh as a daemon-side safety net.
 */
function looksLikeNaturalLanguage(input: string): boolean {
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
function classifyCommand(command: string, exitCode: number): {
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
 * Extract structured memories from an agent's response using Haiku.
 * Runs async after the response is streamed to the user — zero UX impact.
 *
 * Haiku reads the user's prompt + agent response and outputs atomic memory
 * items as JSON-lines. Each item has a type, content, and importance level.
 */
async function extractAndStoreMemories(
  userPrompt: string,
  agentResponse: string,
  memKey: MemoryKey,
): Promise<void> {
  // Skip trivial responses
  if (agentResponse.length < 200) return

  const extractionPrompt = `You are a memory extraction system. Given a user's prompt and an AI agent's response, extract discrete facts worth remembering across sessions.

User asked: "${userPrompt.slice(0, 500)}"

Agent responded:
${agentResponse.slice(0, 6000)}

Extract memories as JSON-lines. Each line must be a valid JSON object with these fields:
- "type": one of "decision", "error-resolution", "task-update", "file-context"
- "content": a concise 1-2 sentence fact (not a summary of the whole response)
- "importance": "high" for architecture/design decisions, "medium" for useful context, "low" for minor details

Rules:
- Only extract facts that would be useful to recall in future sessions
- Each memory should be atomic and self-contained
- Skip greetings, pleasantries, and meta-commentary
- Skip things that are obvious from the codebase itself
- Prefer concrete facts: decisions made, errors resolved, patterns discovered
- Output NOTHING (empty response) if there's nothing worth remembering
- Maximum 10 items

Output only JSON-lines, no other text.`

  const result = await callFastLlm(extractionPrompt, 1000)
  if (!result) return

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

      const eventType = (["decision", "error-resolution", "task-update", "file-context"] as const)
        .find(t => t === item.type) ?? "task-update"
      const importance = (["low", "medium", "high"] as const)
        .find(i => i === item.importance) ?? "medium"

      const event = {
        id: globalThis.crypto.randomUUID(),
        type: eventType,
        timestamp: Date.now(),
        content: item.content.slice(0, 1000),
        importance,
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

  if (stored > 0) {
    log("info", `Extracted ${stored} memories from agent response for ${memKey.projectName}:${memKey.branchName}`)
  }
}

/**
 * Flush the activity buffer for a session, extracting memories via Haiku.
 * Runs asynchronously — call with setTimeout(0) to avoid blocking.
 */
async function flushActivityBuffer(
  sessionKey: string,
  memKey: MemoryKey,
  reasoning?: string,
): Promise<void> {
  const entries = activityBuffers.get(sessionKey)
  activityBuffers.delete(sessionKey)

  if ((!entries || entries.length < ACTIVITY_MIN_FOR_EXTRACTION) && !reasoning) {
    return
  }

  // Format activity as compact list
  const activityLines: string[] = []
  if (entries) {
    for (const e of entries) {
      if (e.filePath) {
        activityLines.push(`- ${e.tool}: ${e.filePath}`)
      } else if (e.command) {
        const cmd = e.command.length > 120 ? e.command.slice(0, 120) + "..." : e.command
        const desc = e.description ? ` (${e.description})` : ""
        activityLines.push(`- Bash: ${cmd}${desc}`)
      } else {
        activityLines.push(`- ${e.tool}`)
      }
    }
  }

  const activityBlock = activityLines.length > 0
    ? `Actions performed:\n${activityLines.join("\n")}`
    : ""

  const reasoningBlock = reasoning
    ? `\nThe agent explained:\n${reasoning.slice(0, 3000)}`
    : ""

  if (!activityBlock && !reasoningBlock) return

  const prompt = `You are a memory extraction system. A coding agent just performed these actions in a coding session:

${activityBlock}${reasoningBlock}

Extract ONLY memories that would be useful to recall in a future session:
- Architecture decisions or library choices made
- Error patterns: what broke and how it was fixed
- Significant changes: major refactors, new features, dependency changes

Output JSON-lines: {"type":"decision"|"error-resolution"|"task-update","content":"...","importance":"high"|"medium"|"low"}

CRITICAL: Output NOTHING (completely empty response) if all actions are routine.
Routine = reading files, running passing tests, minor edits, exploration, formatting.
Do NOT extract memories for trivial actions. Most flushes should produce 0 memories.
Maximum 3 items only if something genuinely notable happened.

Output only JSON-lines, no other text.`

  const result = await callFastLlm(prompt, 500)
  if (!result) return

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

      const eventType = (["decision", "error-resolution", "task-update"] as const)
        .find(t => t === item.type) ?? "task-update"
      const importance = (["low", "medium", "high"] as const)
        .find(i => i === item.importance) ?? "medium"

      const event = {
        id: globalThis.crypto.randomUUID(),
        type: eventType,
        timestamp: Date.now(),
        content: item.content.slice(0, 1000),
        importance,
        metadata: { source: "passive" },
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

  if (stored > 0) {
    log("info", `Passive monitoring: extracted ${stored} memories from ${entries?.length ?? 0} tool calls for ${memKey.projectName}:${memKey.branchName}`)
  }
}

async function handleRequest(
  socket: import("node:net").Socket,
  request: DaemonRequest,
): Promise<void> {
  switch (request.type) {
    case "ping":
      sendResponse(socket, { type: "done", data: "pong" })
      break

    case "status": {
      const ctx = context.getContext()
      const memKey = resolveMemoryKey(ctx.cwd)
      const currentSession = sessions.get(sessionKeyFromMemoryKey(memKey))
      sendResponse(socket, {
        type: "status",
        data: JSON.stringify({
          cwd: ctx.cwd,
          gitBranch: ctx.gitBranch,
          recentCommands: ctx.recentCommands.length,
          uptime: process.uptime(),
          pid: process.pid,
          activeSessions: sessions.size,
          session: currentSession
            ? {
                agent: currentSession.agentName,
                queries: currentSession.queryCount,
                lastResponseLength: currentSession.lastResponse.length,
              }
            : null,
          availableAgents,
        }),
      })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "context-update": {
      const payload = request.payload as ContextUpdatePayload
      context.update(payload)

      // Trigger context file regeneration
      const gitRoot = resolveGitRoot(payload.cwd)
      if (gitRoot) {
        const memKey = resolveMemoryKey(payload.cwd)
        const shellCtx = context.getContext()
        if (payload.event === "chpwd") {
          contextFileGen.regenerateNow(gitRoot, shellCtx, memKey)
          // Check for merged branches on directory change (runs async)
          setTimeout(() => {
            processMergedBranches(gitRoot, memKey.projectKey, memKey.projectName, memKey.origin)
          }, 0)
        } else if (payload.event === "precmd") {
          contextFileGen.scheduleRegeneration(gitRoot, shellCtx, memKey)

          // Persist notable shell commands as memories
          const lastCmd = shellCtx.lastCommand
          const exitCode = payload.exitCode ?? 0
          if (lastCmd) {
            const notable = classifyCommand(lastCmd, exitCode)
            if (notable) {
              setTimeout(() => {
                addTaskEvent(memKey.projectKey, memKey.taskKey, memKey.branchName, {
                  id: globalThis.crypto.randomUUID(),
                  type: notable.type,
                  timestamp: Date.now(),
                  content: notable.content,
                  importance: notable.importance,
                })
              }, 0)
            }
          }
        }
      }

      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "new-session": {
      const payload = request.payload as NewSessionPayload
      const cwd = payload.cwd ?? context.getContext().cwd
      const memKey = resolveMemoryKey(cwd)
      const sKey = sessionKeyFromMemoryKey(memKey)
      const existingSession = sessions.get(sKey)
      if (existingSession) {
        persistSessionMemory(memKey, existingSession)
      }
      // Flush passive activity buffer before resetting
      if (activityBuffers.has(sKey)) {
        flushActivityBuffer(sKey, memKey).catch(() => {})
      }
      sessions.delete(sKey)
      sessionMemoryKeys.delete(sKey)

      // Regenerate context file for new session
      const gitRoot = resolveGitRoot(cwd)
      if (gitRoot) {
        contextFileGen.regenerateNow(gitRoot, context.getContext(), memKey)
      }

      log("info", `Session reset for ${memKey.projectName}:${memKey.branchName}`)
      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "agents": {
      const agentList = Object.entries(builtinAgents).map(([name, config]) => ({
        name,
        description: config.description,
        installed: availableAgents.includes(name),
        supportsContinuation: Boolean(config.continueArgs),
      }))
      sendResponse(socket, { type: "status", data: JSON.stringify(agentList) })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "query": {
      const payload = request.payload as QueryPayload
      const config = loadConfig()

      // Agent selection: explicit > auto-select > default
      let agentName: string
      if (payload.agent) {
        agentName = payload.agent
      } else if (config.defaultAgent === "auto") {
        agentName = selectAgent(payload.prompt, availableAgents, "claude")
      } else {
        agentName = config.defaultAgent
      }

      // Resolve per-branch session
      const memKey = resolveMemoryKey(payload.cwd)

      // Ensure project-level agent instruction files on first contact with a directory
      if (!instructionsDirs.has(payload.cwd)) {
        instructionsDirs.add(payload.cwd)
        const projResult = ensureProjectInstructions(payload.cwd)
        if (projResult.updated.length > 0) {
          log("info", `Updated project instruction files: ${projResult.updated.join(", ")}`)
        }
      }

      const sKey = sessionKeyFromMemoryKey(memKey)
      let session = sessions.get(sKey) ?? null

      // If agent changed or --new was passed, save memory and reset session
      if (payload.newSession || (session && session.agentName !== agentName)) {
        if (session) {
          persistSessionMemory(memKey, session)
        }
        sessions.delete(sKey)
        sessionMemoryKeys.delete(sKey)
        session = null
      }

      // Determine if we should continue an existing session
      const shouldContinue = session !== null && session.agentName === agentName

      // Update cwd context
      if (payload.cwd) {
        context.update({ event: "chpwd", cwd: payload.cwd })
      }

      // Build context — for agents with native continuation, context is only
      // injected on the first message. For others, include last response as context.
      const agentConfig = builtinAgents[agentName]
      let contextBlock = context.formatForPrompt()

      // Add command history
      const ctx = context.getContext()
      const queryHistory = ctx.recentCommands.slice(-20)
        .map(c => `  ${c.exitCode === 0 ? "✓" : "✗"} \`${c.command}\`${c.exitCode !== 0 ? ` (exit ${c.exitCode})` : ""}`)
        .join("\n")
      if (queryHistory) {
        contextBlock += `\n\n[Command history]\n${queryHistory}`
      }

      // Inject persistent memory — search across ALL projects and branches
      if (!shouldContinue) {
        const memoryBlock = searchAllMemory(payload.prompt)
        if (memoryBlock) {
          contextBlock += `\n\n[Long-term memory]\n${memoryBlock}`
        }
      }

      // For agents WITHOUT native continuation, inject last response as pseudo-memory
      if (shouldContinue && !agentConfig?.continueArgs && session?.lastResponse) {
        const truncatedResponse = session.lastResponse.length > 2000
          ? session.lastResponse.slice(0, 2000) + "\n... (truncated)"
          : session.lastResponse
        contextBlock += `\n\nPrevious assistant response:\n${truncatedResponse}`
      }

      let prompt = payload.prompt
      if (payload.pipeInput) {
        prompt = `${payload.pipeInput}\n\n---\n\n${prompt}`
      }

      log("info", `Routing to '${agentName}' [${memKey.projectName}:${memKey.branchName}]${shouldContinue ? " (continuing)" : ""}: ${prompt.slice(0, 100)}...`)

      const result = await routeToAgent(
        prompt,
        agentName,
        contextBlock,
        {
          continueSession: shouldContinue,
          onChunk: (response) => sendResponse(socket, response),
        },
      )

      // Update session state
      if (session && session.agentName === agentName) {
        session.queryCount++
        session.lastResponse = result.fullResponse
      } else {
        sessions.set(sKey, {
          agentName,
          queryCount: 1,
          lastResponse: result.fullResponse,
          startedAt: Date.now(),
        })
        sessionMemoryKeys.set(sKey, memKey)
      }

      // Extract structured memories from the agent's response via Haiku (async, non-blocking).
      // Replaces the old "first 300 chars" summary with intelligent extraction.
      if (result.fullResponse.length > 0) {
        extractAndStoreMemories(prompt, result.fullResponse, memKey).catch((err: unknown) => {
          log("warn", `Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      break
    }

    case "compare": {
      const payload = request.payload as ComparePayload
      const agentNames = payload.agents.filter((a) => availableAgents.includes(a))

      if (agentNames.length === 0) {
        sendResponse(socket, { type: "error", data: `None of the specified agents are installed: ${payload.agents.join(", ")}` })
        sendResponse(socket, { type: "done", data: "" })
        break
      }

      if (payload.cwd) {
        context.update({ event: "chpwd", cwd: payload.cwd })
      }

      const contextBlock = context.formatForPrompt()
      let prompt = payload.prompt
      if (payload.pipeInput) {
        prompt = `${payload.pipeInput}\n\n---\n\n${prompt}`
      }

      log("info", `Comparing agents: ${agentNames.join(", ")} — ${prompt.slice(0, 80)}...`)

      // Run all agents in parallel, collect full responses
      const results = await Promise.all(
        agentNames.map(async (name) => {
          const chunks: string[] = []
          await routeToAgent(prompt, name, contextBlock, {
            continueSession: false,
            onChunk: (response) => {
              if (response.type === "chunk") chunks.push(response.data)
            },
          })
          return { name, response: chunks.join("") }
        }),
      )

      // Display results with agent headers
      for (const result of results) {
        const header = `\n\x1b[1m\x1b[36m━━━ ${result.name} ━━━\x1b[0m\n`
        sendResponse(socket, { type: "chunk", data: header })
        sendResponse(socket, { type: "chunk", data: result.response })
        sendResponse(socket, { type: "chunk", data: "\n" })
      }

      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "suggest": {
      const suggestion = context.getPendingSuggestion()
      sendResponse(socket, { type: "status", data: suggestion ?? "" })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "capture": {
      const payload = request.payload as CapturePayload
      context.storeOutput(payload.output)
      log("info", `Captured ${payload.output.length} chars of command output`)
      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "assist": {
      const payload = request.payload as AssistPayload

      // Skip intentional signals (Ctrl+C = 130, Ctrl+Z = 148)
      if (payload.exitCode === 130 || payload.exitCode === 148) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }

      // No rate limiting — the user controls when they invoke ambient.
      // The 4-second perl alarm in ambient.zsh already prevents runaway calls.

      if (payload.cwd) {
        context.update({ event: "chpwd", cwd: payload.cwd })
      }

      const assistContextBlock = context.formatForPrompt()

      // Include captured command output — prefer direct payload, fall back to stored
      const rawOutput = payload.output ?? context.getLastOutput()
      const outputBlock = rawOutput
        ? `\n\n[Command output]\n${rawOutput.slice(-3000)}`
        : ""

      // Include recent command history
      const assistCtx = context.getContext()
      const recentHistory = assistCtx.recentCommands.slice(-20)
        .map(c => `  ${c.exitCode === 0 ? "✓" : "✗"} \`${c.command}\`${c.exitCode !== 0 ? ` (exit ${c.exitCode})` : ""}`)
        .join("\n")
      const historyBlock = recentHistory ? `\n\n[Command history]\n${recentHistory}` : ""

      // Search persistent memory across ALL projects — TF-IDF + recency scoring
      const memKey = resolveMemoryKey(payload.cwd)
      const userInput = payload.command
      const assistMemory = searchAllMemory(userInput)
      const memoryBlock = assistMemory ? `\n\n[Long-term memory]\n${assistMemory}` : ""

      // Classify the input — exit 127 is always conversational (command not found).
      // For other exit codes, apply heuristic detection as a safety net for when
      // the ZLE widget doesn't catch natural language (e.g. edge cases).
      const input = payload.command
      const isConversational = payload.exitCode === 127 || looksLikeNaturalLanguage(input)

      const stderrBlock = payload.stderr ? `\nStderr: ${payload.stderr.slice(-500)}` : ""
      const errorContext = isConversational ? "" : `\nThe command \`${input}\` failed with exit code ${payload.exitCode}.${stderrBlock}`

      const assistPrompt = `You are "ambient", a persistent AI companion in the user's terminal. You have long-term memory across sessions and can see their shell activity. Be concise by default — a few sentences for simple questions. Go into full detail only when the user explicitly asks for it.

[Shell context]
${assistContextBlock}${historyBlock}${outputBlock}${memoryBlock}${errorContext}

[User]
${input}`

      if (!process.env["ANTHROPIC_API_KEY"]) {
        if (!apiKeyWarned) {
          sendResponse(socket, { type: "chunk", data: "Auto-assist requires ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-ant-...` to your ~/.zshrc" })
          apiKeyWarned = true
        }
        sendResponse(socket, { type: "done", data: "" })
        break
      }

      log("info", `Auto-assist for \`${input}\` (exit ${payload.exitCode}, ${isConversational ? "conversation" : "error"}) via Haiku streaming`)

      // Stream Haiku response — first tokens arrive in ~200-300ms
      const assistChunks: string[] = []
      const ok = await streamFastLlm(assistPrompt, (text) => {
        assistChunks.push(text)
        sendResponse(socket, { type: "chunk", data: text })
      })

      if (!ok) {
        log("warn", "Haiku streaming call failed")
      }

      // Store in ring buffer so ambient remembers what it said
      const fullAssistResponse = assistChunks.join("")
      if (fullAssistResponse) {
        recentAssists.push({
          command: payload.command,
          exitCode: payload.exitCode,
          response: fullAssistResponse,
          timestamp: Date.now(),
        })
        if (recentAssists.length > MAX_RECENT_ASSISTS) {
          recentAssists.shift()
        }
      }

      sendResponse(socket, { type: "done", data: "" })

      // Record the interaction as a memory event (async, non-blocking)
      // Skip trivial inputs: greetings, single words, very short exchanges
      const assistResponse = assistChunks.join("")
      const inputWords = input.trim().split(/\s+/).length
      const isTrivial = inputWords <= 2 && /^(hi|hey|hello|yo|sup|salad|test|ping|lol|ok|yes|no|thanks|bye)\b/i.test(input.trim())

      if (ok && assistResponse.length > 10 && !isTrivial) {
        setTimeout(() => {
          const summary = isConversational
            ? `User asked: "${input.slice(0, 150)}". Ambient responded: ${assistResponse.slice(0, 400).replace(/\n/g, " ").trim()}`
            : `Error with \`${input.slice(0, 100)}\` (exit ${payload.exitCode}). Ambient suggested: ${assistResponse.slice(0, 400).replace(/\n/g, " ").trim()}`
          const eventType = isConversational ? "session-summary" as const : "error-resolution" as const

          // Deduplicate: skip if the most recent event has the same type and similar content
          const existing = loadTaskMemory(memKey.projectKey, memKey.taskKey)
          if (existing && existing.events.length > 0) {
            const last = existing.events[existing.events.length - 1]!
            if (last.type === eventType && last.content.slice(0, 80) === summary.slice(0, 80)) {
              return // duplicate, skip
            }
          }

          addTaskEvent(memKey.projectKey, memKey.taskKey, memKey.branchName, {
            id: globalThis.crypto.randomUUID(),
            type: eventType,
            timestamp: Date.now(),
            content: summary.slice(0, 1000),
            importance: isConversational ? "low" : "medium",
          })
        }, 0)
      }

      break
    }

    case "memory-store": {
      const payload = request.payload as MemoryStorePayload
      const memKey = resolveMemoryKey(payload.cwd)
      const importance = payload.importance ?? "medium"

      const event = {
        id: globalThis.crypto.randomUUID(),
        type: payload.eventType,
        timestamp: Date.now(),
        content: payload.content.slice(0, 1000),
        importance,
        metadata: payload.metadata,
      } as const

      // High-importance events go to both project and task; others just to task
      if (importance === "high") {
        addProjectEvent(memKey.projectKey, memKey.projectName, memKey.origin, event)
      }
      addTaskEvent(memKey.projectKey, memKey.taskKey, memKey.branchName, event)

      // Regenerate context file after memory write (debounced)
      const memStoreGitRoot = resolveGitRoot(payload.cwd)
      if (memStoreGitRoot) {
        contextFileGen.scheduleRegeneration(memStoreGitRoot, context.getContext(), memKey)
      }

      // Trigger compaction asynchronously (non-blocking)
      setTimeout(() => {
        compactTaskIfNeeded(memKey.projectKey, memKey.taskKey).catch(() => {})
        if (importance === "high") {
          compactProjectIfNeeded(memKey.projectKey).catch(() => {})
        }
      }, 0)

      log("info", `Memory stored (${payload.eventType}/${importance}) for ${memKey.projectName}:${memKey.branchName}`)
      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "memory-read": {
      const payload = request.payload as MemoryReadPayload
      const memKey = resolveMemoryKey(payload.cwd)
      const formatted = formatMemoryForPrompt(memKey)
      sendResponse(socket, { type: "status", data: formatted ?? "" })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "context-read": {
      const payload = request.payload as ContextReadPayload
      const cwd = payload.cwd ?? context.getContext().cwd
      const memKey = resolveMemoryKey(cwd)
      const ctx = context.getContext()
      sendResponse(socket, {
        type: "status",
        data: JSON.stringify({
          context: ctx,
          formattedContext: context.formatForPrompt(),
          memory: formatMemoryForPrompt(memKey),
        }),
      })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "memory-delete": {
      const payload = request.payload as MemoryDeletePayload
      if (!payload.cwd || !payload.eventId) {
        sendResponse(socket, { type: "error", data: "memory-delete requires cwd and eventId" })
        break
      }
      const memKey = resolveMemoryKey(payload.cwd)
      const deleted = deleteMemoryEvent(memKey, payload.eventId)
      if (deleted) {
        log("info", `Memory deleted: ${payload.eventId}`)
        const deleteGitRoot = resolveGitRoot(payload.cwd)
        if (deleteGitRoot) {
          contextFileGen.scheduleRegeneration(deleteGitRoot, context.getContext(), memKey)
        }
      }
      // Idempotent: return success whether event existed or not
      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "memory-update": {
      const payload = request.payload as MemoryUpdatePayload
      if (!payload.cwd || !payload.eventId || !payload.newContent) {
        sendResponse(socket, { type: "error", data: "memory-update requires cwd, eventId, and newContent" })
        break
      }
      const memKey = resolveMemoryKey(payload.cwd)
      const updated = updateMemoryEvent(memKey, payload.eventId, payload.newContent)
      if (updated) {
        log("info", `Memory updated: ${payload.eventId}`)
        const updateGitRoot = resolveGitRoot(payload.cwd)
        if (updateGitRoot) {
          contextFileGen.scheduleRegeneration(updateGitRoot, context.getContext(), memKey)
        }
        sendResponse(socket, { type: "done", data: "ok" })
      } else {
        sendResponse(socket, { type: "error", data: `Event not found: ${payload.eventId}` })
      }
      break
    }

    case "memory-search": {
      const payload = request.payload as MemorySearchPayload
      if (!payload.query) {
        sendResponse(socket, { type: "error", data: "memory-search requires a query" })
        break
      }
      const maxEvents = Math.min(payload.maxEvents ?? 25, 100)
      const results = searchAllMemory(payload.query, maxEvents)
      sendResponse(socket, { type: "status", data: results ?? "No matching memories found." })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "output-read": {
      const output = context.getLastOutput()
      sendResponse(socket, { type: "status", data: output ?? "" })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    // --- Passive activity monitoring ---

    case "activity": {
      const payload = request.payload as ActivityPayload
      const memKey = resolveMemoryKey(payload.cwd)
      const sKey = sessionKeyFromMemoryKey(memKey)

      let buffer = activityBuffers.get(sKey)
      if (!buffer) {
        buffer = []
        activityBuffers.set(sKey, buffer)
      }

      buffer.push({
        tool: payload.tool,
        filePath: payload.filePath || undefined,
        command: payload.command || undefined,
        description: payload.description || undefined,
        timestamp: Date.now(),
      })

      // Ring buffer: drop oldest if over max
      if (buffer.length > ACTIVITY_BUFFER_MAX) {
        buffer.splice(0, buffer.length - ACTIVITY_BUFFER_MAX)
      }

      // Auto-flush at threshold
      if (buffer.length >= ACTIVITY_FLUSH_THRESHOLD) {
        setTimeout(() => {
          flushActivityBuffer(sKey, memKey).catch((err: unknown) => {
            log("warn", `Activity flush failed: ${err instanceof Error ? err.message : String(err)}`)
          })
        }, 0)
      }

      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "activity-flush": {
      const payload = request.payload as ActivityFlushPayload
      const memKey = resolveMemoryKey(payload.cwd)
      const sKey = sessionKeyFromMemoryKey(memKey)

      setTimeout(() => {
        flushActivityBuffer(sKey, memKey, payload.reasoning || undefined).catch((err: unknown) => {
          log("warn", `Activity flush failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }, 0)

      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "shutdown":
      log("info", "Shutdown requested")
      sendResponse(socket, { type: "done", data: "shutting down" })
      process.exit(0)
  }
}

async function startDaemon(): Promise<void> {
  const socketPath = getSocketPath()
  const pidPath = getPidPath()

  // Detect available agents on startup
  availableAgents = await detectAvailableAgents()
  log("info", `Available agents: ${availableAgents.join(", ") || "none detected"}`)

  // Ensure global CLAUDE.md has ambient memory instructions
  const mdResult = ensureAmbientInstructions()
  if (mdResult === "added") {
    log("info", "Added ambient memory instructions to global CLAUDE.md")
  } else if (mdResult === "updated") {
    log("info", "Updated ambient memory instructions in global CLAUDE.md")
  }

  // Ensure Claude Code hooks are registered for ambient reminders
  const hookResult = ensureClaudeHooks()
  if (hookResult.added.length > 0) {
    log("info", `Registered Claude Code hooks: ${hookResult.added.join(", ")}`)
  }

  // Migrate legacy memory files to two-level format
  migrateIfNeeded()

  // Clean up stale memory files
  cleanupStaleMemory()

  // Clean up stale socket
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // ignore
    }
  }

  const server = createServer((socket) => {
    let buffer = ""

    socket.on("data", (data) => {
      buffer += data.toString()

      // Protocol: newline-delimited JSON
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const request = JSON.parse(line) as DaemonRequest
          handleRequest(socket, request).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            log("error", `Request handler failed: ${message}`)
            sendResponse(socket, { type: "error", data: message })
            sendResponse(socket, { type: "done", data: "" })
          })
        } catch {
          sendResponse(socket, { type: "error", data: "Invalid JSON" })
          sendResponse(socket, { type: "done", data: "" })
        }
      }
    })

    socket.on("error", (err) => {
      log("debug", `Socket error: ${err.message}`)
    })
  })

  server.listen(socketPath, () => {
    // Write PID file for lifecycle management
    writeFileSync(pidPath, process.pid.toString())
    log("info", `Ambient daemon running (pid ${process.pid}, socket ${socketPath})`)
  })

  // Graceful shutdown
  const shutdown = (): void => {
    log("info", "Shutting down...")
    // Flush all passive activity buffers before exit
    for (const [sKey] of activityBuffers) {
      const memKey = sessionMemoryKeys.get(sKey)
      if (memKey) {
        flushActivityBuffer(sKey, memKey).catch(() => {})
      }
    }
    // Persist all active sessions to memory before exit
    for (const [sKey, session] of sessions) {
      const memKey = sessionMemoryKeys.get(sKey)
      if (memKey) {
        persistSessionMemory(memKey, session)
      }
    }
    server.close()
    try {
      unlinkSync(socketPath)
    } catch { /* ignore */ }
    try {
      unlinkSync(pidPath)
    } catch { /* ignore */ }
    process.exit(0)
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  // Auto-exit after 24h of inactivity (prevents zombie daemons)
  let lastActivity = Date.now()
  const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000

  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log("info", "Idle timeout reached, shutting down")
      shutdown()
    }
  }, 60_000)

  // Refresh activity on any connection
  server.on("connection", () => {
    lastActivity = Date.now()
  })
}

startDaemon().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Failed to start daemon: ${message}\n`)
  process.exit(1)
})
