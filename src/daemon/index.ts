#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { ContextEngine } from "../context/engine.js"
import { routeToAgent } from "../agents/router.js"
import { detectAvailableAgents, builtinAgents } from "../agents/registry.js"
import { selectAgent } from "../agents/selector.js"
import { getSocketPath, getPidPath } from "../config.js"
import type {
  AssistPayload,
  CapturePayload,
  ComparePayload,
  ContextReadPayload,
  ContextUpdatePayload,
  DaemonRequest,
  DaemonResponse,
  MemoryKey,
  MemoryReadPayload,
  MemoryStorePayload,
  NewSessionPayload,
  QueryPayload,
  SessionState,
} from "../types/index.js"
import { loadConfig } from "../config.js"
import { formatMemoryForPrompt, addTaskEvent, addProjectEvent, cleanupStaleMemory } from "../memory/store.js"
import { resolveMemoryKey, resolveGitRoot } from "../memory/resolve.js"
import { migrateIfNeeded } from "../memory/migrate.js"
import { streamFastLlm } from "../assist/fast-llm.js"
import { ContextFileGenerator } from "../memory/context-file.js"
import { compactProjectIfNeeded, compactTaskIfNeeded } from "../memory/compact.js"
import { processMergedBranches } from "../memory/lifecycle.js"

const context = new ContextEngine()
const contextFileGen = new ContextFileGenerator()

// Per-branch session state — keyed by "projectKey:taskKey"
const sessions = new Map<string, SessionState>()
const sessionMemoryKeys = new Map<string, MemoryKey>()

// Rate-limit auto-assist (1 per 10 seconds)
let lastAssistTime = 0

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

  const summary = session.lastResponse.slice(0, 500).trimEnd()

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

      // Inject persistent memory for new sessions (first query in this directory)
      if (!shouldContinue) {
        const memoryBlock = formatMemoryForPrompt(memKey)
        if (memoryBlock) {
          contextBlock += `\n\n${memoryBlock}`
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

      // Rate limit: 1 assist per 5 seconds
      const now = Date.now()
      if (now - lastAssistTime < 5_000) {
        sendResponse(socket, { type: "done", data: "" })
        break
      }
      lastAssistTime = now

      if (payload.cwd) {
        context.update({ event: "chpwd", cwd: payload.cwd })
      }

      const contextBlock = context.formatForPrompt()
      const stderrBlock = payload.stderr ? `\nError output:\n${payload.stderr.slice(-1000)}` : ""

      // Include recent command history (last 20, both successes and failures)
      // so the LLM understands what the user has been doing
      const ctx = context.getContext()
      const recentHistory = ctx.recentCommands.slice(-20)
        .map(c => `  ${c.exitCode === 0 ? "✓" : "✗"} \`${c.command}\`${c.exitCode !== 0 ? ` (exit ${c.exitCode})` : ""}`)
        .join("\n")
      const historyBlock = recentHistory ? `\nRecent terminal activity:\n${recentHistory}` : ""

      const assistPrompt = `You are "ambient", an AI assistant that lives in the user's terminal. You can see everything they've been doing.

The user typed: \`${payload.command}\`
Exit code: ${payload.exitCode}${stderrBlock}

${contextBlock}${historyBlock}

Instructions:
- If the input is NATURAL LANGUAGE (a question, request, or conversation): answer it directly using the terminal context and command history above. DO NOT tell them to run \`history\` — YOU already have their history, so just answer from it.
- If the input is a MISTYPED COMMAND: suggest the correct command.

Reply in 1-3 short plain text lines. No markdown, no code fences.`

      if (!process.env["ANTHROPIC_API_KEY"]) {
        sendResponse(socket, { type: "chunk", data: "Auto-assist requires ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-ant-...` to your ~/.zshrc" })
        sendResponse(socket, { type: "done", data: "" })
        // Only warn once per daemon lifetime
        lastAssistTime = Infinity
        break
      }

      log("info", `Auto-assist for \`${payload.command}\` (exit ${payload.exitCode}) via Haiku streaming`)

      // Stream Haiku response — first tokens arrive in ~200-300ms
      const ok = await streamFastLlm(assistPrompt, (text) => {
        sendResponse(socket, { type: "chunk", data: text })
      })

      if (!ok) {
        log("warn", "Haiku streaming call failed")
      }
      sendResponse(socket, { type: "done", data: "" })

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
        content: payload.content.slice(0, 500),
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
