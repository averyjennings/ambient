#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
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
import { formatMemoryForPrompt, searchAllMemory, addTaskEvent, addProjectEvent, cleanupStaleMemory, loadTaskMemory, deleteMemoryEvent, updateMemoryEvent, getMemoryStats } from "../memory/store.js"
import { looksLikeNaturalLanguage, classifyCommand, parseAndStoreMemoryJsonLines } from "./classify.js"
import { resolveMemoryKey, resolveGitRoot } from "../memory/resolve.js"
import { migrateIfNeeded } from "../memory/migrate.js"
import { streamFastLlm, callFastLlm, setUsageTracker } from "../assist/fast-llm.js"
import { UsageTracker } from "../usage/tracker.js"
import { ContextFileGenerator } from "../memory/context-file.js"
import { compactProjectIfNeeded, compactTaskIfNeeded } from "../memory/compact.js"
import { processMergedBranches } from "../memory/lifecycle.js"
import { ensureAmbientInstructions, ensureProjectInstructions } from "../setup/claude-md.js"
import { ensureClaudeHooks } from "../setup/claude-hooks.js"
import { PrivacyEngine } from "../privacy/engine.js"

const daemonConfig = loadConfig()
const context = new ContextEngine()
const contextFileGen = new ContextFileGenerator()
const privacy = new PrivacyEngine(daemonConfig.privacy)

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

// --- Daemon metrics ---

interface DaemonMetrics {
  startedAt: number
  queriesTotal: number
  assistsTotal: number
  memoryStoresTotal: number
  extractionsActive: number
  extractionsPassive: number
  sessionsCreated: number
  queriesToday: number
  queryTodayDate: string
}

interface ExtractionRecord {
  source: "passive" | "active"
  stored: number
  timestamp: number
}

const metrics: DaemonMetrics = {
  startedAt: Date.now(),
  queriesTotal: 0,
  assistsTotal: 0,
  memoryStoresTotal: 0,
  extractionsActive: 0,
  extractionsPassive: 0,
  sessionsCreated: 0,
  queriesToday: 0,
  queryTodayDate: new Date().toISOString().slice(0, 10),
}

const recentExtractions: ExtractionRecord[] = []
const MAX_EXTRACTION_RECORDS = 20

function incrementQueryMetrics(): void {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== metrics.queryTodayDate) {
    metrics.queriesToday = 0
    metrics.queryTodayDate = today
  }
  metrics.queriesTotal++
  metrics.queriesToday++
}

// Ring buffer of recent assist interactions so ambient remembers what it said
interface AssistEntry {
  readonly command: string
  readonly exitCode: number
  readonly response: string
  readonly timestamp: number
}
const recentAssists: AssistEntry[] = []
const MAX_RECENT_ASSISTS = 50

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
 * Extract structured memories from an agent's response using Haiku.
 * Runs async after the response is streamed to the user — zero UX impact.
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

Extract memories as JSON-lines. Each line must be a valid JSON object:
- "type": "decision" | "error-resolution" | "task-update" | "file-context"
- "content": concise 1-2 sentence fact
- "importance": importance level (see rules)

Importance rules (STRICT):
- "high": ONLY for architecture/framework/database/auth strategy decisions that affect the whole project. Most sessions produce 0 high items.
- "medium": error fixes, config changes, dependency additions, non-trivial patterns
- "low": file touched, test passed, minor context

Rules:
- Only extract facts useful in future sessions
- Each memory must be atomic and self-contained
- Skip greetings, pleasantries, meta-commentary, obvious codebase facts
- Output NOTHING if there's nothing worth remembering
- Maximum 5 items

Output only JSON-lines, no other text.`

  const result = await callFastLlm(extractionPrompt, 1000, undefined, "extract")
  if (!result) return

  const stored = parseAndStoreMemoryJsonLines(result, memKey)

  if (stored > 0) {
    metrics.extractionsActive++
    recentExtractions.push({ source: "active", stored, timestamp: Date.now() })
    if (recentExtractions.length > MAX_EXTRACTION_RECORDS) {
      recentExtractions.shift()
    }
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

  const prompt = `You are a memory extraction system. A coding agent just performed these actions:

${activityBlock}${reasoningBlock}

Extract ONLY memories useful in a future session:
- Architecture decisions or library choices explicitly made
- Error patterns: what broke and how it was fixed
- Significant changes: major refactors, new features, dependency changes

Output JSON-lines: {"type":"decision"|"error-resolution"|"task-update","content":"...","importance":"high"|"medium"|"low"}

Importance rules (STRICT):
- "high": ONLY for architecture/framework/database decisions. Almost never.
- "medium": error resolutions, significant code changes
- "low": everything else worth noting

Output NOTHING (empty response) if all actions are routine.
Routine = reading files, running passing tests, minor edits, exploration, formatting.
Maximum 3 items only if something genuinely notable happened.

Output only JSON-lines, no other text.`

  const result = await callFastLlm(prompt, 500, undefined, "flush")
  if (!result) return

  const stored = parseAndStoreMemoryJsonLines(result, memKey, {
    validTypes: ["decision", "error-resolution", "task-update"],
    metadata: { source: "passive" },
  })

  if (stored > 0) {
    metrics.extractionsPassive++
    recentExtractions.push({ source: "passive", stored, timestamp: Date.now() })
    if (recentExtractions.length > MAX_EXTRACTION_RECORDS) {
      recentExtractions.shift()
    }
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
      const memStats = getMemoryStats()
      const uptime = (Date.now() - metrics.startedAt) / 1000

      // Try to get usage tracker data
      let usageData: {
        apiRequests: number
        inputTokens: number
        outputTokens: number
        estimatedCost: number
        allTimeRequests: number
        allTimeCost: number
      } | null = null
      try {
        const usagePath = join(homedir(), ".ambient", "usage.json")
        const raw = readFileSync(usagePath, "utf-8")
        const usage = JSON.parse(raw) as {
          daily?: Record<string, { requestCount?: number; inputTokens?: number; outputTokens?: number; totalCost?: number }>
          allTime?: { requestCount?: number; totalCost?: number }
        }
        const today = new Date().toISOString().slice(0, 10)
        const todayUsage = usage.daily?.[today]
        usageData = {
          apiRequests: todayUsage?.requestCount ?? 0,
          inputTokens: todayUsage?.inputTokens ?? 0,
          outputTokens: todayUsage?.outputTokens ?? 0,
          estimatedCost: todayUsage?.totalCost ?? 0,
          allTimeRequests: usage.allTime?.requestCount ?? 0,
          allTimeCost: usage.allTime?.totalCost ?? 0,
        }
      } catch { /* no usage data */ }

      const statusData = {
        daemon: {
          pid: process.pid,
          uptime,
          socketPath: daemonConfig.socketPath,
          memoryRSS: process.memoryUsage().rss,
          startedAt: metrics.startedAt,
        },
        memory: memStats,
        sessions: {
          active: sessions.size,
          queriesTotal: metrics.queriesTotal,
          queriesToday: metrics.queriesToday,
          assistsTotal: metrics.assistsTotal,
          agentsUsed: [...new Set(
            [...sessions.values()].map(s => s.agentName).filter(Boolean),
          )],
        },
        usage: usageData,
        extractions: {
          total: metrics.extractionsActive + metrics.extractionsPassive,
          active: metrics.extractionsActive,
          passive: metrics.extractionsPassive,
          recent: recentExtractions.slice(-5),
        },
        config: {
          defaultAgent: daemonConfig.defaultAgent,
          apiKeyPresent: !!process.env["ANTHROPIC_API_KEY"],
          availableAgents,
        },
      }

      sendResponse(socket, { type: "status", data: JSON.stringify(statusData) })
      sendResponse(socket, { type: "done", data: "" })
      break
    }

    case "context-update": {
      const payload = request.payload as ContextUpdatePayload

      // Privacy: skip ignored directories entirely
      if (privacy.isIgnored(payload.cwd)) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }

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
      metrics.sessionsCreated++
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
      incrementQueryMetrics()

      // Privacy: skip ignored directories
      if (privacy.isIgnored(payload.cwd)) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }

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

      // Inject persistent memory — scoped to current project + branch
      if (!shouldContinue) {
        const scopedMemory = formatMemoryForPrompt(memKey)
        if (scopedMemory) {
          contextBlock += `\n\n[Long-term memory]\n${scopedMemory}`
        }
        // Add limited cross-project context (query handler always has real queries)
        const crossProject = searchAllMemory(payload.prompt, 10)
        if (crossProject) {
          contextBlock += `\n\n[Other projects]\n${crossProject}`
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
      metrics.assistsTotal++

      // Skip intentional signals (Ctrl+C = 130, Ctrl+Z = 148)
      if (payload.exitCode === 130 || payload.exitCode === 148) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }

      // Privacy: skip ignored directories
      if (privacy.isIgnored(payload.cwd)) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }

      // Privacy: block API calls in local-only mode
      if (!privacy.shouldAllowApiCall()) {
        sendResponse(socket, { type: "chunk", data: "ambient is in local-only mode. API calls are disabled.\n" })
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

      // Classify the input — exit 127 is always conversational (command not found).
      // For other exit codes, apply heuristic detection as a safety net for when
      // the ZLE widget doesn't catch natural language (e.g. edge cases).
      const memKey = resolveMemoryKey(payload.cwd)
      const userInput = payload.command
      // Sanitize command before sending to LLM — strip inline secrets
      const input = privacy.sanitize(payload.command)
      const isConversational = payload.exitCode === 127 || looksLikeNaturalLanguage(input)

      // Primary: scoped memory for current project + branch
      const scopedMemory = formatMemoryForPrompt(memKey)
      let memoryBlock = scopedMemory ? `\n\n[Long-term memory]\n${scopedMemory}` : ""

      // Secondary: cross-project context for non-conversational queries
      if (!isConversational) {
        const crossProject = searchAllMemory(userInput, 10)
        if (crossProject) {
          memoryBlock += `\n\n[Other projects]\n${crossProject}`
        }
      }

      const stderrBlock = payload.stderr ? `\nStderr: ${payload.stderr.slice(-500)}` : ""
      const errorContext = isConversational ? "" : `\nThe command \`${input}\` failed with exit code ${payload.exitCode}.${stderrBlock}`

      // Include recent conversation so ambient remembers what the user said.
      // Recent messages get full responses, older ones get truncated.
      let conversationBlock = ""
      if (recentAssists.length > 0) {
        const lines: string[] = []
        let budget = 6000
        for (let i = recentAssists.length - 1; i >= 0 && budget > 0; i--) {
          const a = recentAssists[i]!
          const isRecent = i >= recentAssists.length - 10
          const maxResp = isRecent ? 600 : 150
          const resp = a.response.length > maxResp
            ? a.response.slice(0, maxResp) + "..."
            : a.response
          const entry = `User: ${a.command}\nAmbient: ${resp}`
          budget -= entry.length
          if (budget >= 0) lines.unshift(entry)
        }
        conversationBlock = `\n\n[Recent conversation]\n${lines.join("\n\n")}`
      }

      const systemMessage = `You are "ambient", a persistent AI companion in the user's terminal. You have long-term memory across sessions and can see their shell activity. Be concise by default — a few sentences for simple questions. Go into full detail only when the user explicitly asks for it.`

      const assistPrompt = `[Shell context]
${assistContextBlock}${historyBlock}${outputBlock}${memoryBlock}${conversationBlock}${errorContext}

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
      }, systemMessage, "assist")

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

      // Record error-assist interactions as permanent memories.
      // Conversational exchanges (greetings, questions) are ephemeral —
      // handled by the recentAssists ring buffer for in-session recall,
      // not worth persisting to disk.
      const assistResponse = assistChunks.join("")

      if (ok && assistResponse.length > 10 && !isConversational) {
        setTimeout(() => {
          const summary = `Error with \`${input.slice(0, 100)}\` (exit ${payload.exitCode}). Ambient suggested: ${assistResponse.slice(0, 400).replace(/\n/g, " ").trim()}`
          const eventType = "error-resolution" as const

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
            importance: "medium",
          })
        }, 0)
      }

      break
    }

    case "memory-store": {
      const payload = request.payload as MemoryStorePayload
      metrics.memoryStoresTotal++
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

      // Privacy: skip ignored directories and when monitoring is off
      if (privacy.isIgnored(payload.cwd) || !privacy.isPassiveMonitoringEnabled()) {
        sendResponse(socket, { type: "done", data: "ok" })
        break
      }

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

      // Privacy: skip ignored directories and when monitoring is off
      if (privacy.isIgnored(payload.cwd) || !privacy.isPassiveMonitoringEnabled()) {
        sendResponse(socket, { type: "done", data: "ok" })
        break
      }

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

  // Initialize usage tracker for token/cost monitoring
  const tracker = new UsageTracker(join(homedir(), ".ambient"), {
    dailyBudgetUsd: daemonConfig.dailyBudgetUsd ?? null,
    warnAtPercent: daemonConfig.budgetWarnPercent ?? 80,
  })
  tracker.load()
  setUsageTracker(tracker)

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
