#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { ContextEngine } from "../context/engine.js"
import { routeToAgent } from "../agents/router.js"
import { detectAvailableAgents, builtinAgents } from "../agents/registry.js"
import { selectAgent } from "../agents/selector.js"
import { getSocketPath, getPidPath } from "../config.js"
import type {
  AssistPayload,
  CapturePayload,
  ComparePayload,
  ContextUpdatePayload,
  DaemonRequest,
  DaemonResponse,
  NewSessionPayload,
  QueryPayload,
  SessionState,
} from "../types/index.js"
import { loadConfig } from "../config.js"
import { formatMemoryForPrompt, saveMemory, cleanupStaleMemory } from "../memory/store.js"
import { callFastLlm } from "../assist/fast-llm.js"

const context = new ContextEngine()

// Per-directory session state — keyed by git root or cwd
const sessions = new Map<string, SessionState>()

// Cache git root lookups to avoid repeated subprocess calls
const gitRootCache = new Map<string, string>()

// Rate-limit auto-assist (1 per 10 seconds)
let lastAssistTime = 0

function resolveSessionKey(cwd: string): string {
  if (gitRootCache.has(cwd)) {
    return gitRootCache.get(cwd)!
  }

  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    gitRootCache.set(cwd, root)
    return root
  } catch {
    gitRootCache.set(cwd, cwd)
    return cwd
  }
}

// Cache of available agents (detected on startup)
let availableAgents: string[] = []

/**
 * Save a session's last response as persistent memory for the directory.
 * Uses the last response truncated as a summary (a proper summarization
 * step could be added later by querying the agent).
 */
function persistSessionMemory(directory: string, session: SessionState): void {
  if (!session.lastResponse || session.queryCount < 1) return

  // Use the first 500 chars of the last response as a rough summary
  const summary = session.lastResponse.slice(0, 500).trimEnd()

  saveMemory({
    directory,
    lastAgent: session.agentName,
    lastActive: Date.now(),
    summary,
    facts: [],
  })
  log("info", `Saved memory for ${directory}`)
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
      const sessionKey = resolveSessionKey(ctx.cwd)
      const currentSession = sessions.get(sessionKey)
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
      sendResponse(socket, { type: "done", data: "ok" })
      break
    }

    case "new-session": {
      const payload = request.payload as NewSessionPayload
      const cwd = payload.cwd ?? context.getContext().cwd
      const key = resolveSessionKey(cwd)
      const existingSession = sessions.get(key)
      if (existingSession) {
        persistSessionMemory(key, existingSession)
      }
      sessions.delete(key)
      log("info", `Session reset for ${key}`)
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

      // Resolve per-directory session
      const sessionKey = resolveSessionKey(payload.cwd)
      let session = sessions.get(sessionKey) ?? null

      // If agent changed or --new was passed, save memory and reset session
      if (payload.newSession || (session && session.agentName !== agentName)) {
        if (session) {
          persistSessionMemory(sessionKey, session)
        }
        sessions.delete(sessionKey)
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
        const memoryBlock = formatMemoryForPrompt(sessionKey)
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

      log("info", `Routing to '${agentName}' [${sessionKey}]${shouldContinue ? " (continuing)" : ""}: ${prompt.slice(0, 100)}...`)

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
        sessions.set(sessionKey, {
          agentName,
          queryCount: 1,
          lastResponse: result.fullResponse,
          startedAt: Date.now(),
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

      const assistPrompt = `The user just ran \`${payload.command}\` in their terminal and it failed with exit code ${payload.exitCode}.${stderrBlock}

${contextBlock}${historyBlock}

What went wrong and what's the correct command? Reply in 1-2 short plain text lines. No markdown, no code fences, no explanation — just the fix.`

      if (!process.env["ANTHROPIC_API_KEY"]) {
        sendResponse(socket, { type: "chunk", data: "Auto-assist requires ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-ant-...` to your ~/.zshrc" })
        sendResponse(socket, { type: "done", data: "" })
        // Only warn once per daemon lifetime
        lastAssistTime = Infinity
        break
      }

      log("info", `Auto-assist for \`${payload.command}\` (exit ${payload.exitCode}) via Haiku direct API`)

      // Direct API call to Haiku — ~1s vs 3-5s for subprocess spawn
      const result = await callFastLlm(assistPrompt)

      if (result?.text) {
        sendResponse(socket, { type: "chunk", data: result.text })
      }
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
    for (const [key, session] of sessions) {
      persistSessionMemory(key, session)
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
