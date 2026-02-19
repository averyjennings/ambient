#!/usr/bin/env node

import { connect } from "node:net"
import { spawn, execSync } from "node:child_process"
import { existsSync, readFileSync, openSync, mkdirSync, statSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { getSocketPath, getPidPath, getLogPath, loadConfig } from "../config.js"
import type { DaemonRequest, DaemonResponse, TemplateConfig } from "../types/index.js"
// Re-export parseArgs for external use (used by tests and consumers)
export { parseArgs } from "./parse-args.js"
export type { ParsedCommand } from "./parse-args.js"

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

  // Set up log file for daemon stderr
  const logPath = getLogPath()
  mkdirSync(dirname(logPath), { recursive: true })
  // Rotate if over 5MB
  try {
    const logStat = statSync(logPath)
    if (logStat.size > 5 * 1024 * 1024) {
      renameSync(logPath, logPath + ".old")
    }
  } catch { /* file may not exist */ }
  const logFd = openSync(logPath, "a")

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ["ignore", "ignore", logFd],
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

  // Interactive setup wizard
  if (args[0] === "init") {
    const { runWizard } = await import("../setup/wizard.js")
    const nonInteractive = args.includes("--non-interactive") || args.includes("-y")
    await runWizard({ nonInteractive })
    return
  }

  // Run as an MCP server (for configuring in agent MCP settings)
  // Usage: Add to Claude Code's MCP config as: node /path/to/ambient/dist/cli/index.js mcp-serve
  if (args[0] === "mcp-serve") {
    const { startMcpServer } = await import("../mcp/server.js")
    await startMcpServer()
    return
  }

  // Set up agent integration (instruction files + Claude Code hooks)
  // This runs automatically on daemon startup, but can be triggered manually.
  // `ambient setup` — global + project-level (existing files only)
  // `ambient setup --agents codex,gemini` — also create instruction files for named agents
  if (args[0] === "setup") {
    const { ensureAmbientInstructions } = await import("../setup/claude-md.js")
    const { ensureClaudeHooks } = await import("../setup/claude-hooks.js")

    // Global ~/CLAUDE.md
    const mdResult = ensureAmbientInstructions()
    console.log(`Global ~/CLAUDE.md: ${mdResult}`)

    // Claude Code hooks
    const hookResult = ensureClaudeHooks()
    if (hookResult.added.length > 0) {
      console.log(`Claude Code hooks added: ${hookResult.added.join(", ")}`)
    }
    if (hookResult.skipped.length > 0) {
      console.log(`Claude Code hooks already present: ${hookResult.skipped.join(", ")}`)
    }

    console.log(`\nSetup complete.`)
    return
  }

  if (args[0] === "daemon") {
    if (args[1] === "stop") {
      await sendRequest({ type: "shutdown", payload: {} })
      console.log("Daemon stopped.")
      return
    }
    if (args[1] === "status") {
      await ensureDaemonRunning()
      await handleStatusCommand(args.slice(2))
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

  // Enhanced status command (alias for daemon status)
  if (args[0] === "status") {
    await ensureDaemonRunning()
    await handleStatusCommand(args.slice(1))
    return
  }

  // View daemon logs
  if (args[0] === "logs") {
    handleLogsCommand(args.slice(1))
    return
  }

  // Quick health check
  if (args[0] === "health") {
    handleHealthCommand()
    return
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

  // Privacy controls
  if (args[0] === "privacy") {
    await handlePrivacyCommand(args.slice(1))
    return
  }

  // Usage / cost tracking
  if (args[0] === "usage") {
    await handleUsageCommand(args.slice(1))
    return
  }

  // Compare: run multiple agents in parallel on the same query
  if (args[0] === "compare") {
    const compareArgs = args.slice(1)
    let agents: string[] = []
    const promptParts: string[] = []

    for (let i = 0; i < compareArgs.length; i++) {
      if ((compareArgs[i] === "--agents" || compareArgs[i] === "-a") && compareArgs[i + 1]) {
        agents = compareArgs[i + 1]!.split(",")
        i++
      } else {
        promptParts.push(compareArgs[i]!)
      }
    }

    const comparePrompt = promptParts.join(" ")
    if (!comparePrompt) {
      console.error("Usage: r compare [-a agent1,agent2] \"your query\"")
      process.exit(1)
    }

    // Default to comparing all installed agents if none specified
    if (agents.length === 0) {
      agents = ["claude", "gemini", "codex"]
    }

    const pipeInput = await readStdin()
    await ensureDaemonRunning()
    await sendRequest({
      type: "compare",
      payload: { prompt: comparePrompt, agents, pipeInput, cwd: process.cwd() },
    })
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

  // Auto-assist: called by shell hook when a command fails
  // Usage: r assist <command> <exit-code> [stderr]
  if (args[0] === "assist") {
    const failedCommand = args[1]
    const exitCode = parseInt(args[2] ?? "1", 10)
    if (!failedCommand) return

    // Read captured command output from stdin if piped
    const capturedOutput = await readStdin()

    await ensureDaemonRunning()
    await sendRequest({
      type: "assist",
      payload: {
        command: failedCommand,
        exitCode,
        cwd: process.cwd(),
        output: capturedOutput,
      },
    })
    return
  }

  // Store a memory — usable by any agent via shell command
  // Usage: r remember "Chose JWT for auth" [--type decision|task-update|error-resolution] [--importance high|medium|low]
  if (args[0] === "remember") {
    const memArgs = args.slice(1)
    let eventType = "decision" as import("../types/index.js").MemoryEventType
    let importance = "high" as import("../types/index.js").MemoryImportance
    const contentParts: string[] = []

    const validTypes = new Set(["decision", "error-resolution", "task-update", "file-context", "session-summary"])
    const validImportance = new Set(["low", "medium", "high"])

    for (let i = 0; i < memArgs.length; i++) {
      if (memArgs[i] === "--type" && memArgs[i + 1]) {
        const t = memArgs[i + 1]!
        if (!validTypes.has(t)) {
          console.error(`Invalid type: ${t}. Valid: decision, task-update, error-resolution, file-context, session-summary`)
          process.exit(1)
        }
        eventType = t as import("../types/index.js").MemoryEventType
        i++
      } else if (memArgs[i] === "--importance" && memArgs[i + 1]) {
        const imp = memArgs[i + 1]!
        if (!validImportance.has(imp)) {
          console.error(`Invalid importance: ${imp}. Valid: low, medium, high`)
          process.exit(1)
        }
        importance = imp as import("../types/index.js").MemoryImportance
        i++
      } else {
        contentParts.push(memArgs[i]!)
      }
    }

    const content = contentParts.join(" ")
    if (!content) {
      console.error('Usage: r remember "what to remember" [--type decision] [--importance high]')
      process.exit(1)
    }

    await ensureDaemonRunning()
    await sendRequest({
      type: "memory-store",
      payload: {
        cwd: process.cwd(),
        eventType,
        content,
        importance,
      },
    })
    console.log(`Remembered: ${content}`)
    return
  }

  // List stored memories for the current project/branch
  if (args[0] === "memory") {
    await ensureDaemonRunning()
    await sendRequest({
      type: "memory-read",
      payload: { cwd: process.cwd() },
    })
    return
  }

  // Memory browsing UX: list, search, delete, edit, export, import, stats
  if (args[0] === "memories") {
    const { handleMemoriesCommand } = await import("./memories.js")
    await handleMemoriesCommand(args.slice(1))
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

// --- Format helpers ---

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainMin = minutes % 60
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function formatTimeAgo(timestamp: number): string {
  const ms = Date.now() - timestamp
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// --- Status command ---

interface StatusData {
  daemon: {
    pid: number
    uptime: number
    socketPath: string
    memoryRSS: number
    startedAt: number
  }
  memory: {
    projectCount: number
    taskCount: number
    totalEvents: number
    diskUsageBytes: number
    lastCompaction: number | null
  }
  sessions: {
    active: number
    queriesTotal: number
    queriesToday: number
    assistsTotal: number
    agentsUsed: string[]
  }
  usage: {
    apiRequests: number
    inputTokens: number
    outputTokens: number
    estimatedCost: number
    allTimeRequests: number
    allTimeCost: number
  } | null
  extractions: {
    total: number
    active: number
    passive: number
    recent: Array<{ source: string; stored: number; timestamp: number }>
  }
  config: {
    defaultAgent: string
    apiKeyPresent: boolean
    availableAgents: string[]
  }
}

async function handleStatusCommand(subArgs: string[]): Promise<void> {
  const isJson = subArgs.includes("--json")

  const socketPath = getSocketPath()
  await new Promise<void>((resolve) => {
    const socket = connect(socketPath)
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "status", payload: {} }) + "\n")
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
          if (isJson) {
            console.log(response.data)
          } else {
            formatStatusOutput(JSON.parse(response.data) as StatusData)
          }
        }
        if (response.type === "done") {
          socket.end()
          resolve()
        }
      }
    })
    socket.on("error", () => resolve())
  })
}

function formatStatusOutput(s: StatusData): void {
  console.log("\n\x1b[1mDaemon\x1b[0m")
  console.log(`  PID:     ${s.daemon.pid}       Uptime: ${formatUptime(s.daemon.uptime)}`)
  console.log(`  Socket:  ${s.daemon.socketPath}`)
  console.log(`  Memory:  ${formatBytes(s.daemon.memoryRSS)} RSS`)

  console.log("\n\x1b[1mMemory Store\x1b[0m")
  console.log(`  Projects: ${s.memory.projectCount}    Tasks: ${s.memory.taskCount}    Events: ${s.memory.totalEvents}`)
  console.log(`  Disk:     ${formatBytes(s.memory.diskUsageBytes)}`)
  if (s.memory.lastCompaction) {
    console.log(`  Last compaction: ${formatTimeAgo(s.memory.lastCompaction)}`)
  }

  console.log("\n\x1b[1mSessions\x1b[0m")
  console.log(`  Active:  ${s.sessions.active}`)
  console.log(`  Queries: ${s.sessions.queriesToday} today (${s.sessions.queriesTotal} total)`)
  console.log(`  Assists: ${s.sessions.assistsTotal} total`)
  if (s.sessions.agentsUsed.length > 0) {
    console.log(`  Agents:  ${s.sessions.agentsUsed.join(", ")}`)
  }

  if (s.extractions.total > 0) {
    console.log("\n\x1b[1mExtractions\x1b[0m")
    console.log(`  Total: ${s.extractions.total} (active: ${s.extractions.active}, passive: ${s.extractions.passive})`)
    if (s.extractions.recent.length > 0) {
      for (const r of s.extractions.recent) {
        console.log(`    ${r.source}: ${r.stored} memories (${formatTimeAgo(r.timestamp)})`)
      }
    }
  }

  if (s.usage) {
    console.log("\n\x1b[1mAPI Usage\x1b[0m")
    console.log(`  Requests: ${s.usage.apiRequests} today`)
    console.log(`  Tokens:   ${formatTokens(s.usage.inputTokens)} in / ${formatTokens(s.usage.outputTokens)} out`)
    console.log(`  Cost:     $${s.usage.estimatedCost.toFixed(4)} today ($${s.usage.allTimeCost.toFixed(4)} all-time)`)
  }

  console.log("\n\x1b[1mConfig\x1b[0m")
  console.log(`  Default agent: ${s.config.defaultAgent}`)
  console.log(`  API key:       ${s.config.apiKeyPresent ? "present" : "\x1b[33mmissing\x1b[0m"}`)
  if (s.config.availableAgents.length > 0) {
    console.log(`  Agents:        ${s.config.availableAgents.join(", ")}`)
  }
  console.log()
}

// --- Logs command ---

function handleLogsCommand(subArgs: string[]): void {
  const logPath = getLogPath()
  if (!existsSync(logPath)) {
    console.error("No log file found at " + logPath)
    process.exit(1)
  }

  const follow = subArgs.includes("-f")
  const nIdx = subArgs.indexOf("-n")
  const lines = nIdx >= 0 ? parseInt(subArgs[nIdx + 1] || "50", 10) : 50

  if (follow) {
    const child = spawn("tail", ["-f", logPath], { stdio: "inherit" })
    process.on("SIGINT", () => child.kill())
  } else {
    const content = readFileSync(logPath, "utf-8")
    const allLines = content.split("\n")
    const lastN = allLines.slice(-lines).join("\n")
    process.stdout.write(lastN + "\n")
  }
}

// --- Health command ---

function readPidFile(): number {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return -1
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
    process.kill(pid, 0) // test if process exists
    return pid
  } catch {
    return -1
  }
}

function handleHealthCommand(): void {
  const config = loadConfig()
  let allPassed = true

  const check = (name: string, ok: boolean, detail: string): void => {
    const icon = ok ? "\x1b[32m+\x1b[0m" : "\x1b[31mx\x1b[0m"
    console.log(`  ${icon} ${name.padEnd(20)} ${detail}`)
    if (!ok) allPassed = false
  }

  console.log("\n\x1b[1mambient health\x1b[0m\n")

  // Check daemon
  const pid = readPidFile()
  check("Daemon", pid > 0, pid > 0 ? `running (pid ${pid})` : "not running")

  // Check socket
  const socketExists = existsSync(config.socketPath)
  check("Socket", socketExists, socketExists ? config.socketPath : "not found")

  // Check API key
  const hasKey = !!process.env["ANTHROPIC_API_KEY"]
  check("API key", hasKey, hasKey ? "ANTHROPIC_API_KEY set" : "missing")

  // Check memory dir
  const memDir = join(homedir(), ".ambient", "memory")
  check("Memory dir", existsSync(memDir), memDir)

  // Check Claude hooks
  const settingsPath = join(homedir(), ".claude", "settings.json")
  let hooksOk = false
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks?: { SessionStart?: unknown[] }
    }
    hooksOk = Array.isArray(settings.hooks?.SessionStart) && settings.hooks.SessionStart.length > 0
  } catch { /* no settings file */ }
  check("Claude hooks", hooksOk, hooksOk ? "registered" : "not found")

  // Check global CLAUDE.md
  let mdOk = false
  for (const p of [join(homedir(), "CLAUDE.md"), join(homedir(), ".claude", "CLAUDE.md")]) {
    try {
      const content = readFileSync(p, "utf-8")
      mdOk = content.includes("ambient:memory-instructions")
      if (mdOk) break
    } catch { /* file not found */ }
  }
  check("Global CLAUDE.md", mdOk, mdOk ? "ambient section present" : "missing")

  // Check log file
  const logPath = getLogPath()
  let logDetail = "not found"
  try {
    const logStat = statSync(logPath)
    logDetail = `${formatBytes(logStat.size)} (${logPath})`
  } catch { /* no log file */ }
  check("Log file", existsSync(logPath), logDetail)

  console.log(allPassed ? "\n  All checks passed.\n" : "\n  Some checks failed.\n")
  process.exit(allPassed ? 0 : 1)
}

async function handlePrivacyCommand(subArgs: string[]): Promise<void> {
  const { existsSync: fileExists, readFileSync: readFile, writeFileSync: writeFile, mkdirSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { homedir } = await import("node:os")

  const ambientDir = join(homedir(), ".ambient")
  const configPath = join(ambientDir, "config.json")
  const ignorePath = join(ambientDir, "ignore")

  function readConfig(): Record<string, unknown> {
    if (!fileExists(configPath)) return {}
    try {
      return JSON.parse(readFile(configPath, "utf-8")) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function writeConfig(cfg: Record<string, unknown>): void {
    mkdirSync(ambientDir, { recursive: true })
    writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n")
  }

  function getPrivacy(cfg: Record<string, unknown>): Record<string, unknown> {
    return (cfg["privacy"] as Record<string, unknown>) ?? {}
  }

  const action = subArgs[0]

  if (action === "local-only") {
    const value = subArgs[1]
    if (value !== "on" && value !== "off") {
      console.error("Usage: ambient privacy local-only on|off")
      process.exit(1)
    }
    const cfg = readConfig()
    cfg["privacy"] = { ...getPrivacy(cfg), localOnly: value === "on" }
    writeConfig(cfg)
    console.log(`Local-only mode: ${value === "on" ? "enabled" : "disabled"}`)
    console.log("Restart the daemon for changes to take effect: ambient daemon stop && ambient daemon start")
    return
  }

  if (action === "monitoring") {
    const value = subArgs[1]
    if (value !== "on" && value !== "off") {
      console.error("Usage: ambient privacy monitoring on|off")
      process.exit(1)
    }
    const cfg = readConfig()
    cfg["privacy"] = { ...getPrivacy(cfg), passiveMonitoring: value === "on" }
    writeConfig(cfg)
    console.log(`Passive monitoring: ${value === "on" ? "enabled" : "disabled"}`)
    console.log("Restart the daemon for changes to take effect: ambient daemon stop && ambient daemon start")
    return
  }

  if (action === "clear") {
    const memoryDir = join(ambientDir, "memory")
    if (!fileExists(memoryDir)) {
      console.log("No memory data found.")
      return
    }
    // Require explicit --yes flag for safety
    if (!subArgs.includes("--yes")) {
      console.log(`This will delete all memory in ${memoryDir}`)
      console.log("Run with --yes to confirm: ambient privacy clear --yes")
      return
    }
    rmSync(memoryDir, { recursive: true, force: true })
    console.log("All memory data deleted.")
    return
  }

  if (action === "ignore") {
    if (!fileExists(ignorePath)) {
      console.log("No ignore file found at ~/.ambient/ignore")
      console.log("Create one with directory patterns (one per line) to opt out of monitoring.")
      return
    }
    const content = readFile(ignorePath, "utf-8")
    console.log(`\x1b[1mIgnore patterns\x1b[0m (${ignorePath}):\n`)
    console.log(content)
    return
  }

  // Default: show privacy status
  const cfg = readConfig()
  const priv = getPrivacy(cfg)
  const localOnly = priv["localOnly"] === true
  const monitoring = priv["passiveMonitoring"] !== false
  const hasIgnore = fileExists(ignorePath)

  console.log(`\x1b[1mAmbient Privacy Status\x1b[0m\n`)
  console.log(`  Local-only mode:     ${localOnly ? "\x1b[33menabled\x1b[0m (no API calls)" : "\x1b[32mdisabled\x1b[0m"}`)
  console.log(`  Passive monitoring:  ${monitoring ? "\x1b[32menabled\x1b[0m" : "\x1b[33mdisabled\x1b[0m"}`)
  console.log(`  Ignore file:         ${hasIgnore ? ignorePath : "\x1b[90mnot configured\x1b[0m"}`)
  console.log(`  Memory directory:    ${join(ambientDir, "memory")}`)
  console.log(`  Config file:         ${configPath}`)
  console.log()
  console.log(`\x1b[1mData collected:\x1b[0m`)
  console.log(`  - Command history (recent 50, in-memory only)`)
  console.log(`  - Memory events (decisions, errors, task updates) stored in ~/.ambient/memory/`)
  console.log(`  - Passive tool monitoring (file edits, commands by agents)`)
  console.log()
  console.log(`\x1b[1mCommands:\x1b[0m`)
  console.log(`  ambient privacy local-only on|off    Toggle local-only mode (disables API calls)`)
  console.log(`  ambient privacy monitoring on|off     Toggle passive monitoring`)
  console.log(`  ambient privacy clear --yes           Delete all stored memory data`)
  console.log(`  ambient privacy ignore                Show ignore patterns`)
}

async function handleUsageCommand(subArgs: string[]): Promise<void> {
  const { join } = await import("node:path")
  const { homedir } = await import("node:os")
  const { UsageTracker } = await import("../usage/tracker.js")

  const ambientDir = join(homedir(), ".ambient")
  const tracker = new UsageTracker(ambientDir)
  tracker.load()

  // --reset: clear usage data
  if (subArgs.includes("--reset")) {
    if (!subArgs.includes("--yes")) {
      console.log("This will reset all usage tracking data.")
      console.log("Run with --yes to confirm: ambient usage --reset --yes")
      return
    }
    tracker.reset()
    console.log("Usage data cleared.")
    return
  }

  // --json: raw JSON output
  if (subArgs.includes("--json")) {
    const data = {
      today: tracker.todaySummary(),
      byPurpose: tracker.summaryByPurpose(),
      allTime: tracker.allTimeSummary(),
      dailyBreakdown: tracker.dailyBreakdown(7),
    }
    console.log(JSON.stringify(data, null, 2))
    return
  }

  // Default: formatted human-readable output
  const today = tracker.todaySummary()
  const byPurpose = tracker.summaryByPurpose()
  const allTime = tracker.allTimeSummary()
  const dateStr = new Date().toISOString().slice(0, 10)

  const fmtNum = (n: number): string => n.toLocaleString()
  const fmtCost = (n: number): string => `$${n.toFixed(4)}`

  console.log(`\x1b[1mToday (${dateStr})\x1b[0m`)
  console.log(`  Requests:  ${fmtNum(today.requestCount)}`)
  console.log(`  Tokens:    ${fmtNum(today.inputTokens)} in / ${fmtNum(today.outputTokens)} out`)
  console.log(`  Cost:      ${fmtCost(today.totalCost)}`)

  const purposes = Object.entries(byPurpose)
  if (purposes.length > 0) {
    console.log()
    console.log(`  \x1b[1mBy purpose:\x1b[0m`)
    for (const [purpose, summary] of purposes) {
      const calls = summary.requestCount === 1 ? "call" : "calls"
      console.log(`    ${purpose.padEnd(9)} ${summary.requestCount} ${calls}   ${fmtCost(summary.totalCost)}`)
    }
  }

  console.log()
  console.log(`\x1b[1mAll-time:\x1b[0m ${fmtNum(allTime.requestCount)} calls, ${fmtCost(allTime.totalCost)}`)
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
  r compare -a claude,gemini <query> Compare responses from multiple agents

\x1b[1mMemory:\x1b[0m
  r remember "fact or decision"      Store a long-term memory
  r remember --type task-update "x"  Store with specific type
  r memory                           Show memories for current project

\x1b[1mMemory browsing:\x1b[0m
  r memories                         Browse memories (newest first)
  r memories --type decision         Filter by type
  r memories --since 7d              Filter by recency
  r memories search <query>          Search across all projects
  r memories delete <event-id>       Delete an event
  r memories edit <event-id>         Edit an event in $EDITOR
  r memories export                  Export all memory to JSON
  r memories import <file.json>      Import from JSON
  r memories stats                   Aggregate statistics

\x1b[1mObservability:\x1b[0m
  r status                           Full daemon status dashboard
  r status --json                    Raw JSON status output
  r health                           Quick diagnostic checks
  r logs                             Show last 50 lines of daemon log
  r logs -f                          Follow daemon log in real-time
  r logs -n 100                      Show last N lines

\x1b[1mDaemon:\x1b[0m
  r daemon start                     Start the background daemon
  r daemon stop                      Stop the daemon
  r daemon status                    Show daemon status + session info

\x1b[1mSetup:\x1b[0m
  r init                             Interactive setup wizard (shell, API key, hooks)
  r init -y                          Non-interactive setup (accept all defaults)
  r setup                            Set up agent integrations (instructions + hooks)
  r setup --agents codex,gemini      Also create instruction files for named agents

\x1b[1mMCP:\x1b[0m
  r mcp-serve                        Run as MCP server (for agent configs)

\x1b[1mUsage tracking:\x1b[0m
  r usage                            Show token usage and costs
  r usage --json                     Output raw JSON
  r usage --reset --yes              Clear all usage data

\x1b[1mPrivacy:\x1b[0m
  r privacy                          Show privacy status and settings
  r privacy local-only on|off        Toggle local-only mode (no API calls)
  r privacy monitoring on|off        Toggle passive monitoring
  r privacy clear --yes              Delete all stored memory data
  r privacy ignore                   Show ignore patterns from ~/.ambient/ignore

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
