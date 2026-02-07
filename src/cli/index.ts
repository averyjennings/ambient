#!/usr/bin/env node

import { connect } from "node:net"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { getSocketPath, getPidPath } from "../config.js"
import type { DaemonRequest, DaemonResponse } from "../types/index.js"

function isDaemonAlive(): boolean {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return false
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()

    function tryConnect(): void {
      if (Date.now() - start > timeoutMs) {
        resolve() // give up, sendRequest will fail with a clear error
        return
      }

      const socket = connect(socketPath)
      socket.on("connect", () => {
        socket.end()
        resolve()
      })
      socket.on("error", () => {
        setTimeout(tryConnect, 100)
      })
    }

    tryConnect()
  })
}

async function ensureDaemonRunning(): Promise<void> {
  const socketPath = getSocketPath()

  if (isDaemonAlive()) {
    return
  }

  // Start the daemon in the background
  const daemonScript = new URL("../daemon/index.js", import.meta.url).pathname
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  // Wait for the socket to accept connections (not just exist on disk)
  await waitForSocket(socketPath, 5000)
}

function sendRequest(request: DaemonRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath()
    const socket = connect(socketPath)

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n")
    })

    let buffer = ""
    socket.on("data", (data) => {
      buffer += data.toString()

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line) as DaemonResponse

          switch (response.type) {
            case "chunk":
              process.stdout.write(response.data)
              break
            case "error":
              process.stderr.write(`\x1b[31m${response.data}\x1b[0m\n`)
              break
            case "status":
              process.stdout.write(response.data + "\n")
              break
            case "done":
              socket.end()
              resolve()
              return
          }
        } catch {
          // Partial JSON — wait for more data
        }
      }
    })

    socket.on("error", (err) => {
      reject(new Error(`Cannot connect to ambient daemon: ${err.message}`))
    })

    socket.on("close", () => {
      resolve()
    })
  })
}

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined
  }

  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (chunk) => {
      data += chunk
    })
    process.stdin.on("end", () => {
      resolve(data || undefined)
    })
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Handle subcommands
  if (args[0] === "daemon") {
    if (args[1] === "stop") {
      await sendRequest({ type: "shutdown", payload: {} })
      console.log("Daemon stopped.")
      return
    }
    if (args[1] === "status") {
      await ensureDaemonRunning()
      await sendRequest({ type: "status", payload: {} })
      return
    }
    if (args[1] === "start") {
      await ensureDaemonRunning()
      console.log("Daemon running.")
      return
    }
    console.error("Usage: r daemon [start|stop|status]")
    process.exit(1)
  }

  // Fire-and-forget notification to daemon (used by shell hooks)
  if (args[0] === "notify") {
    const json = args.slice(1).join(" ")
    if (!json) {
      process.exit(1)
    }
    const socketPath = getSocketPath()
    if (!existsSync(socketPath)) {
      return // daemon not running, silently skip
    }
    try {
      const socket = connect(socketPath)
      socket.on("connect", () => {
        socket.write(json + "\n")
        socket.end()
      })
      socket.on("error", () => {
        // silently ignore — this is fire-and-forget
      })
      // Don't wait for response — exit immediately
      setTimeout(() => process.exit(0), 200)
    } catch {
      // silently ignore
    }
    return
  }

  if (args[0] === "config") {
    const { getConfigPath } = await import("../config.js")
    console.log(`Config: ${getConfigPath()}`)
    console.log(`Socket: ${getSocketPath()}`)
    console.log(`PID: ${getPidPath()}`)
    return
  }

  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    printUsage()
    return
  }

  // Parse --agent flag
  let agentName: string | undefined
  const queryArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1]) {
      agentName = args[i + 1]
      i++ // skip next arg
    } else {
      queryArgs.push(args[i]!)
    }
  }

  const prompt = queryArgs.join(" ")
  if (!prompt) {
    printUsage()
    process.exit(1)
  }

  // Read piped input if any
  const pipeInput = await readStdin()

  // Ensure daemon is running
  await ensureDaemonRunning()

  // Send query
  const cwd = process.cwd()
  await sendRequest({
    type: "query",
    payload: {
      prompt,
      agent: agentName,
      pipeInput,
      cwd,
    },
  })
}

function printUsage(): void {
  console.log(`
\x1b[1mambient\x1b[0m — agentic shell layer

\x1b[1mUsage:\x1b[0m
  r <natural language query>         Query using default agent
  r --agent <name> <query>           Query using specific agent
  r -a claude <query>                Short form
  cat file | r "explain this"        Pipe input as context

\x1b[1mDaemon:\x1b[0m
  r daemon start                     Start the background daemon
  r daemon stop                      Stop the daemon
  r daemon status                    Show daemon status

\x1b[1mAgents:\x1b[0m
  claude, codex, gemini, goose, aider, copilot, opencode, gptme

\x1b[1mConfig:\x1b[0m
  r config                           Show config paths
  ~/.ambient/config.json             Configuration file
`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`\x1b[31mError: ${message}\x1b[0m\n`)
  process.exit(1)
})
