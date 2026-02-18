import { createInterface } from "node:readline"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { detectShell, detectAllShells } from "./shell-detect.js"
import { installShellHooks, getShellScriptPath } from "./shell-install.js"
import { ensureAmbientInstructions, ensureProjectInstructions } from "./claude-md.js"
import { ensureClaudeHooks } from "./claude-hooks.js"
import { checkApiKey, validateApiKey } from "./api-key.js"
import { ensureGlobalGitignore } from "./gitignore.js"
import { ensureMcpRegistration } from "./mcp-register.js"
import type { ShellInfo } from "./shell-detect.js"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

interface WizardOptions {
  nonInteractive?: boolean
}

export async function runWizard(options?: WizardOptions): Promise<void> {
  console.log(`
  ${BOLD}ambient${RESET} — agentic shell layer
  Making any coding agent context-aware
`)

  const defaultShell = await stepShellDetection(options)
  await stepApiKey(options)
  await stepShellIntegration(defaultShell, options)
  await stepDaemon()
  await stepAgentInstructions()

  console.log(`
  ${GREEN}All set!${RESET} Open a new terminal tab, then try:
    ${BOLD}r "what project am I in?"${RESET}
    ${BOLD}r review${RESET}
    ${BOLD}rc pnpm build${RESET}
`)
}

// --- Step 1: Shell Detection ---

async function stepShellDetection(_options?: WizardOptions): Promise<ShellInfo> {
  console.log(`  ${BOLD}Step 1/5: Shell Detection${RESET}`)

  const defaultShell = detectShell()
  const allShells = detectAllShells()

  if (defaultShell.shell === "unknown") {
    console.log(`  ${YELLOW}!${RESET} Could not detect default shell`)
  } else {
    const version = defaultShell.version ? ` ${defaultShell.version}` : ""
    console.log(`  ${GREEN}+${RESET} Detected: ${defaultShell.shell}${version} (default shell)`)
    if (!defaultShell.meetsMinVersion) {
      console.log(`  ${YELLOW}!${RESET} Warning: ${defaultShell.shell}${version} may be too old for full functionality`)
    }
  }

  const others = allShells.filter(s => s.shell !== defaultShell.shell)
  if (others.length > 0) {
    const otherNames = others.map(s => {
      const v = s.version ? ` ${s.version}` : ""
      return `${s.shell}${v}`
    })
    console.log(`  ${DIM}Also found: ${otherNames.join(", ")}${RESET}`)
  }

  console.log()
  return defaultShell
}

// --- Step 2: API Key ---

async function stepApiKey(options?: WizardOptions): Promise<void> {
  console.log(`  ${BOLD}Step 2/5: API Key${RESET}`)

  const status = checkApiKey()

  if (status.found) {
    console.log(`  ${GREEN}+${RESET} ANTHROPIC_API_KEY is set`)
    console.log()
    return
  }

  console.log(`  ${YELLOW}!${RESET} ANTHROPIC_API_KEY not found`)
  console.log(`  Auto-assist and memory extraction require an Anthropic API key.`)
  console.log(`  You can get one at: https://console.anthropic.com/`)
  console.log()

  if (options?.nonInteractive) {
    console.log(`  ${DIM}Skipping key prompt (non-interactive mode)${RESET}`)
    console.log()
    return
  }

  const key = await promptLine("  Paste your key (or press Enter to skip): ")

  if (!key) {
    console.log(`  ${DIM}Skipped — you can set ANTHROPIC_API_KEY later${RESET}`)
    console.log()
    return
  }

  console.log(`  Validating...`)
  const valid = await validateApiKey(key)

  if (valid) {
    console.log(`  ${GREEN}+${RESET} Key validated successfully`)
    console.log()
    console.log(`  Add to your shell profile:`)
    console.log(`    ${DIM}export ANTHROPIC_API_KEY="${key}"${RESET}`)
  } else {
    console.log(`  ${RED}x${RESET} Key appears invalid (got 401 from API)`)
    console.log(`  ${DIM}You can set ANTHROPIC_API_KEY later${RESET}`)
  }

  console.log()
}

// --- Step 3: Shell Integration ---

async function stepShellIntegration(defaultShell: ShellInfo, options?: WizardOptions): Promise<void> {
  console.log(`  ${BOLD}Step 3/5: Shell Integration${RESET}`)

  const ambientRoot = findAmbientRoot()

  if (defaultShell.shell === "unknown") {
    console.log(`  ${YELLOW}!${RESET} No supported shell detected, skipping hook installation`)
    console.log()
    return
  }

  const scriptPath = getShellScriptPath(defaultShell.shell, ambientRoot)

  if (!existsSync(scriptPath)) {
    console.log(`  ${YELLOW}!${RESET} Shell script not found: ${scriptPath}`)
    console.log()
    return
  }

  const shouldInstall = options?.nonInteractive
    ? true
    : await promptYesNo(`  Install hooks into ${defaultShell.rcFile}?`, true)

  if (shouldInstall) {
    const result = installShellHooks(defaultShell.rcFile, scriptPath)
    if (result.status === "installed") {
      console.log(`  ${GREEN}+${RESET} Added ambient hooks to ${defaultShell.rcFile}`)
    } else if (result.status === "already-present") {
      console.log(`  ${GREEN}+${RESET} Hooks already present in ${defaultShell.rcFile}`)
    } else {
      console.log(`  ${RED}x${RESET} Failed to install hooks to ${defaultShell.rcFile}`)
    }
  } else {
    console.log(`  ${DIM}Skipped${RESET}`)
  }

  // Ask about additional shells
  const allShells = detectAllShells()
  const others = allShells.filter(
    (s): s is ShellInfo & { shell: "zsh" | "bash" | "fish" } =>
      s.shell !== defaultShell.shell && s.shell !== "unknown",
  )

  for (const otherShell of others) {
    const otherScript = getShellScriptPath(otherShell.shell, ambientRoot)
    if (!existsSync(otherScript)) continue

    const installOther = options?.nonInteractive
      ? false
      : await promptYesNo(`  Also install into ${otherShell.rcFile}?`, false)

    if (installOther) {
      const result = installShellHooks(otherShell.rcFile, otherScript)
      if (result.status === "installed") {
        console.log(`  ${GREEN}+${RESET} Added ambient hooks to ${otherShell.rcFile}`)
      } else if (result.status === "already-present") {
        console.log(`  ${GREEN}+${RESET} Hooks already present in ${otherShell.rcFile}`)
      } else {
        console.log(`  ${RED}x${RESET} Failed to install hooks to ${otherShell.rcFile}`)
      }
    }
  }

  console.log()
}

// --- Step 4: Daemon ---

async function stepDaemon(): Promise<void> {
  console.log(`  ${BOLD}Step 4/5: Daemon${RESET}`)

  try {
    // Dynamic import to reuse existing daemon startup logic
    const { spawn } = await import("node:child_process")
    const { connect } = await import("node:net")
    const { getSocketPath, getPidPath, getLogPath } = await import("../config.js")
    const { existsSync: exists, readFileSync: readFile, openSync, mkdirSync, statSync, renameSync } = await import("node:fs")

    const pidPath = getPidPath()

    // Check if already running
    if (exists(pidPath)) {
      const pid = parseInt(readFile(pidPath, "utf-8").trim(), 10)
      try {
        process.kill(pid, 0)
        console.log(`  ${GREEN}+${RESET} Daemon already running (pid ${pid})`)
        console.log()
        return
      } catch {
        // stale pid file
      }
    }

    const daemonScript = new URL("../daemon/index.js", import.meta.url).pathname
    const logPath = getLogPath()
    mkdirSync(dirname(logPath), { recursive: true })
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

    // Wait for socket to become available
    const socketPath = getSocketPath()
    await new Promise<void>((resolve) => {
      const start = Date.now()
      function tryConnect(): void {
        if (Date.now() - start > 5000) {
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

    // Read PID from file
    if (exists(pidPath)) {
      const pid = readFile(pidPath, "utf-8").trim()
      console.log(`  ${GREEN}+${RESET} Daemon started (pid ${pid})`)
    } else {
      console.log(`  ${GREEN}+${RESET} Daemon started`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ${RED}x${RESET} Failed to start daemon: ${msg}`)
  }

  console.log()
}

// --- Step 5: Agent Instructions ---

async function stepAgentInstructions(): Promise<void> {
  console.log(`  ${BOLD}Step 5/5: Agent Instructions${RESET}`)

  const mdResult = ensureAmbientInstructions()
  if (mdResult === "failed") {
    console.log(`  ${RED}x${RESET} Failed to update global CLAUDE.md`)
  } else {
    console.log(`  ${GREEN}+${RESET} Updated ~/CLAUDE.md with memory instructions (${mdResult})`)
  }

  const hookResult = ensureClaudeHooks()
  if (hookResult.added.length > 0) {
    console.log(`  ${GREEN}+${RESET} Registered Claude Code hooks: ${hookResult.added.join(", ")}`)
  } else {
    console.log(`  ${GREEN}+${RESET} Claude Code hooks already registered`)
  }

  const mcpResult = ensureMcpRegistration()
  if (mcpResult === "added") {
    console.log(`  ${GREEN}+${RESET} Registered ambient MCP server in ~/.claude.json`)
  } else if (mcpResult === "already-present") {
    console.log(`  ${GREEN}+${RESET} MCP server already registered`)
  } else {
    console.log(`  ${YELLOW}!${RESET} Could not register MCP server (CLI not built?)`)
  }

  const gitignoreResult = ensureGlobalGitignore()
  if (gitignoreResult === "added") {
    console.log(`  ${GREEN}+${RESET} Added .ambient/ to global gitignore`)
  } else if (gitignoreResult === "already-present") {
    console.log(`  ${GREEN}+${RESET} Global gitignore already has .ambient/`)
  } else {
    console.log(`  ${YELLOW}!${RESET} Could not update global gitignore`)
  }

  // Update project-level instructions if in a project directory
  const cwd = process.cwd()
  const projectResult = ensureProjectInstructions(cwd)
  if (projectResult.updated.length > 0) {
    console.log(`  ${GREEN}+${RESET} Updated project instruction files: ${projectResult.updated.join(", ")}`)
  }
  if (projectResult.current.length > 0) {
    console.log(`  ${DIM}  Project files already current: ${projectResult.current.join(", ")}${RESET}`)
  }

  console.log()
}

// --- Helpers ---

function findAmbientRoot(): string {
  // Resolve from this file's location: src/setup/wizard.ts -> project root
  const thisFile = fileURLToPath(import.meta.url)
  // In dist: dist/setup/wizard.js -> go up 2 levels
  // In src: src/setup/wizard.ts -> go up 2 levels
  return dirname(dirname(dirname(thisFile)))
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]"
  const answer = await promptLine(`${question} ${hint} `)
  const trimmed = answer.trim().toLowerCase()

  if (trimmed === "") return defaultYes
  return trimmed === "y" || trimmed === "yes"
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve("")
      return
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}
