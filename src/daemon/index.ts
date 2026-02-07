#!/usr/bin/env node

import { createServer } from "node:net"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { ContextEngine } from "../context/engine.js"
import { routeToAgent } from "../agents/router.js"
import { getSocketPath, getPidPath } from "../config.js"
import type {
  ContextUpdatePayload,
  DaemonRequest,
  DaemonResponse,
  QueryPayload,
} from "../types/index.js"
import { loadConfig } from "../config.js"

const context = new ContextEngine()

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
      sendResponse(socket, {
        type: "status",
        data: JSON.stringify({
          cwd: ctx.cwd,
          gitBranch: ctx.gitBranch,
          recentCommands: ctx.recentCommands.length,
          uptime: process.uptime(),
          pid: process.pid,
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

    case "query": {
      const payload = request.payload as QueryPayload
      const config = loadConfig()
      const agentName = payload.agent ?? config.defaultAgent

      // Build context block for prompt injection
      // Temporarily update cwd if provided
      if (payload.cwd) {
        context.update({ event: "chpwd", cwd: payload.cwd })
      }
      const contextBlock = context.formatForPrompt()

      let prompt = payload.prompt
      if (payload.pipeInput) {
        prompt = `${payload.pipeInput}\n\n---\n\n${prompt}`
      }

      log("info", `Routing to '${agentName}': ${prompt.slice(0, 100)}...`)

      await routeToAgent(
        prompt,
        agentName,
        contextBlock,
        (response) => sendResponse(socket, response),
      )
      break
    }

    case "shutdown":
      log("info", "Shutdown requested")
      sendResponse(socket, { type: "done", data: "shutting down" })
      process.exit(0)
  }
}

function startDaemon(): void {
  const socketPath = getSocketPath()
  const pidPath = getPidPath()

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

  // We track activity in the server connection handler above
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

startDaemon()
