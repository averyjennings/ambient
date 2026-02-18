import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

interface McpServerEntry {
  type?: string
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

/**
 * Resolve the absolute path to the ambient CLI entry point.
 * Works from both src/ (dev) and dist/ (installed).
 */
function resolveAmbientCliPath(): string {
  // This file lives at dist/setup/mcp-register.js (or src/setup/mcp-register.ts)
  // The CLI is at dist/cli/index.js relative to the project root
  const thisFile = new URL(import.meta.url).pathname
  // Go up from setup/ to dist/ (or src/), then into cli/
  const setupDir = thisFile.replace(/\/[^/]+$/, "")
  const parentDir = setupDir.replace(/\/[^/]+$/, "")
  return join(parentDir, "cli", "index.js")
}

/**
 * Ensure the ambient MCP server is registered in ~/.claude.json.
 * Idempotent — skips if an "ambient" entry already exists.
 * Returns "added" | "already-present" | "failed".
 */
export function ensureMcpRegistration(): "added" | "already-present" | "failed" {
  try {
    const configPath = join(homedir(), ".claude.json")
    const cliPath = resolveAmbientCliPath()

    // Verify the CLI file actually exists before registering
    if (!existsSync(cliPath)) {
      return "failed"
    }

    let config: ClaudeConfig = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as ClaudeConfig
    } else {
      mkdirSync(join(homedir(), ".claude"), { recursive: true })
    }

    if (!config.mcpServers) {
      config.mcpServers = {}
    }

    // Skip if ambient is already registered
    if (config.mcpServers["ambient"]) {
      // Update the path if it changed (e.g. user moved the repo)
      const existing = config.mcpServers["ambient"]
      const currentArgs = [cliPath, "mcp-serve"]
      const argsMatch = existing.args.length === currentArgs.length
        && existing.args.every((a, i) => a === currentArgs[i])

      if (argsMatch) {
        return "already-present"
      }

      // Path changed — update it
      config.mcpServers["ambient"] = {
        type: "stdio",
        command: "node",
        args: currentArgs,
        env: {},
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
      return "added"
    }

    config.mcpServers["ambient"] = {
      type: "stdio",
      command: "node",
      args: [cliPath, "mcp-serve"],
      env: {},
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    return "added"
  } catch {
    return "failed"
  }
}
