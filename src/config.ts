import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { AmbientConfig } from "./types/index.js"
import { builtinAgents } from "./agents/registry.js"

function getAmbientDir(): string {
  const dir = join(homedir(), ".ambient")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getSocketPath(): string {
  // Use XDG_RUNTIME_DIR if available, otherwise tmpdir
  const runtimeDir = process.env["XDG_RUNTIME_DIR"] ?? tmpdir()
  return join(runtimeDir, `ambient-${process.getuid?.() ?? "default"}.sock`)
}

export function getPidPath(): string {
  return join(getAmbientDir(), "daemon.pid")
}

export function getConfigPath(): string {
  return join(getAmbientDir(), "config.json")
}

export function loadConfig(): AmbientConfig {
  const configPath = getConfigPath()

  const defaults: AmbientConfig = {
    defaultAgent: "claude",
    agents: builtinAgents,
    maxRecentCommands: 50,
    socketPath: getSocketPath(),
    logLevel: "info",
  }

  if (!existsSync(configPath)) {
    return defaults
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(raw) as Partial<AmbientConfig>
    return { ...defaults, ...userConfig }
  } catch {
    return defaults
  }
}
