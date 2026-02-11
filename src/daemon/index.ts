#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { ContextEngine } from "../context/engine.js"
import { routeToAgent } from "../agents/router.js"
import { detectAvailableAgents, builtinAgents } from "../agents/registry.js"
import { getSocketPath, getPidPath } from "../config.js"
import type {
  CapturePayload,
  ContextUpdatePayload,
  DaemonRequest,
  DaemonResponse,
  NewSessionPayload,
  QueryPayload,
  SessionState,
} from "../types/index.js"
import { loadConfig } from "../config.js"
import { formatMemoryForPrompt, saveMemory, cleanupStaleMemory } from "../memory/store.js"

const context = new ContextEngine()

// Per-directory session state — keyed by git root or cwd
const sessions = new Map<string, SessionState>()

// Cache git root lookups to avoid repeated subprocess calls
const gitRootCache = new Map<string, string>()

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
      const agentName = payload.agent ?? config.defaultAgent

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

    case "capture": {
      const payload = request.payload as CapturePayload
      context.storeOutput(payload.output)
      log("info", `Captured ${payload.output.length} chars of command output`)
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
