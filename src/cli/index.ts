#!/usr/bin/env node

import { connect } from "node:net"
import { spawn, execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { getSocketPath, getPidPath, loadConfig } from "../config.js"
import type { DaemonRequest, DaemonResponse, TemplateConfig } from "../types/index.js"

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
        resolve()
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

  const daemonScript = new URL("../daemon/index.js", import.meta.url).pathname
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()

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

  // --- Subcommands ---

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
      return
    }
    try {
      const socket = connect(socketPath)
      socket.on("connect", () => {
        socket.write(json + "\n")
        socket.end()
      })
      socket.on("error", () => {
        // silently ignore
      })
      setTimeout(() => process.exit(0), 200)
    } catch {
      // silently ignore
    }
    return
  }

  // Check for proactive suggestions (called by shell hook)
  if (args[0] === "suggest") {
    const socketPath = getSocketPath()
    if (!existsSync(socketPath)) return
    try {
      const socket = connect(socketPath)
      socket.on("connect", () => {
        socket.write(JSON.stringify({ type: "suggest", payload: {} }) + "\n")
      })
      let buf = ""
      socket.on("data", (data) => {
        buf += data.toString()
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          const response = JSON.parse(line) as DaemonResponse
          if (response.type === "status" && response.data) {
            // Output suggestion for the shell hook to display
            process.stdout.write(response.data)
          }
          if (response.type === "done") {
            socket.end()
          }
        }
      })
      socket.on("error", () => { /* ignore */ })
      setTimeout(() => process.exit(0), 200)
    } catch {
      // ignore
    }
    return
  }

  // Capture command output and store in daemon for context injection
  if (args[0] === "capture") {
    const pipeInput = await readStdin()
    if (!pipeInput) {
      console.error("Usage: command 2>&1 | r capture")
      process.exit(1)
    }
    await ensureDaemonRunning()
    await sendRequest({
      type: "capture",
      payload: { output: pipeInput, cwd: process.cwd() },
    })
    // Also write the captured output to stdout so piping is transparent
    process.stdout.write(pipeInput)
    return
  }

  // Start a new conversation (reset session state for current directory)
  if (args[0] === "new") {
    await ensureDaemonRunning()
    await sendRequest({ type: "new-session", payload: { cwd: process.cwd() } })
    console.log("New session started.")
    return
  }

  // List available agents
  if (args[0] === "agents") {
    await ensureDaemonRunning()
    // Override the default status handler to format agent list nicely
    const socketPath = getSocketPath()
    await new Promise<void>((resolve) => {
      const socket = connect(socketPath)
      socket.on("connect", () => {
        socket.write(JSON.stringify({ type: "agents", payload: {} }) + "\n")
      })
      let buf = ""
      socket.on("data", (data) => {
        buf += data.toString()
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          const response = JSON.parse(line) as DaemonResponse
          if (response.type === "status") {
            const agents = JSON.parse(response.data) as Array<{
              name: string
              description: string
              installed: boolean
              supportsContinuation: boolean
            }>
            console.log("\x1b[1mAvailable agents:\x1b[0m\n")
            for (const agent of agents) {
              const status = agent.installed ? "\x1b[32m installed\x1b[0m" : "\x1b[90m not found\x1b[0m"
              const cont = agent.supportsContinuation ? " [session]" : ""
              console.log(`  ${agent.installed ? "\x1b[1m" : "\x1b[90m"}${agent.name}\x1b[0m — ${agent.description}${cont}${status}`)
            }
            console.log("\n\x1b[90m[session] = supports multi-turn conversation continuation\x1b[0m")
          }
          if (response.type === "done") {
            socket.end()
            resolve()
          }
        }
      })
      socket.on("error", () => resolve())
    })
    return
  }

  if (args[0] === "config") {
    const { getConfigPath } = await import("../config.js")
    console.log(`Config: ${getConfigPath()}`)
    console.log(`Socket: ${getSocketPath()}`)
    console.log(`PID: ${getPidPath()}`)
    return
  }

  // List available templates
  if (args[0] === "templates") {
    const config = loadConfig()
    console.log("\x1b[1mAvailable templates:\x1b[0m\n")
    for (const [name, tmpl] of Object.entries(config.templates)) {
      const desc = tmpl.description ?? tmpl.prompt.slice(0, 60)
      const cmd = tmpl.command ? ` \x1b[90m(runs: ${tmpl.command})\x1b[0m` : ""
      console.log(`  \x1b[1m${name}\x1b[0m — ${desc}${cmd}`)
    }
    console.log("\n\x1b[90mUsage: r <template> [extra args...]\x1b[0m")
    return
  }

  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    printUsage()
    return
  }

  // --- Parse flags ---
  let agentName: string | undefined
  let newSession = false
  const queryArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--agent" || args[i] === "-a") && args[i + 1]) {
      agentName = args[i + 1]
      i++
    } else if (args[i] === "--new" || args[i] === "-n") {
      newSession = true
    } else {
      queryArgs.push(args[i]!)
    }
  }

  let prompt = queryArgs.join(" ")
  if (!prompt) {
    printUsage()
    process.exit(1)
  }

  let pipeInput = await readStdin()

  // --- Template resolution ---
  // Check if the first word matches a template name
  const config = loadConfig()
  const firstWord = queryArgs[0]!
  const template = config.templates[firstWord] as TemplateConfig | undefined
  if (template) {
    const extraArgs = queryArgs.slice(1).join(" ")
    prompt = extraArgs ? `${template.prompt}\n\n${extraArgs}` : template.prompt

    // Execute template command and use as pipe input
    if (template.command && !pipeInput) {
      try {
        pipeInput = execSync(template.command, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (err: unknown) {
        // Command may fail (e.g., no staged changes for git diff --cached)
        const stderr = err instanceof Error && "stderr" in err ? (err as { stderr: string }).stderr : ""
        if (stderr) {
          process.stderr.write(`\x1b[33mTemplate command '${template.command}' warning: ${stderr.trim()}\x1b[0m\n`)
        }
      }
    }
  }

  await ensureDaemonRunning()

  const cwd = process.cwd()
  await sendRequest({
    type: "query",
    payload: {
      prompt,
      agent: agentName,
      pipeInput,
      cwd,
      newSession,
    },
  })
}

function printUsage(): void {
  console.log(`
\x1b[1mambient\x1b[0m — agentic shell layer

\x1b[1mUsage:\x1b[0m
  r <query>                          Query using default agent
  r --agent <name> <query>           Query using specific agent
  r -a claude <query>                Short form
  r --new <query>                    Start a new conversation
  cat file | r "explain this"        Pipe input as context
  rc pnpm build                      Run command and capture output on failure

\x1b[1mConversation:\x1b[0m
  Queries automatically continue the current session.
  The agent remembers what you discussed previously.
  r new                              Start a fresh conversation
  r --new <query>                    New conversation with a query

\x1b[1mTemplates:\x1b[0m
  r review                           Review unstaged changes
  r commit                           Generate commit message
  r fix                              Fix the last failed command
  r test src/auth.ts                 Generate tests for a file
  r explain src/utils.ts             Explain code
  r templates                        List all templates

\x1b[1mAgents:\x1b[0m
  r agents                           List available agents
  r -a codex <query>                 Use a specific agent

\x1b[1mDaemon:\x1b[0m
  r daemon start                     Start the background daemon
  r daemon stop                      Stop the daemon
  r daemon status                    Show daemon status + session info

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
