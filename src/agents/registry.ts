import type { AgentConfig } from "../types/index.js"

/**
 * Built-in agent configurations.
 *
 * Each agent defines how to invoke its CLI in headless mode.
 * The router uses these configs to spawn the right subprocess
 * and stream output back to the user's terminal.
 *
 * `continueArgs` — if present, these args are appended to resume
 * the last session instead of starting fresh. This enables
 * multi-turn conversations through the daemon.
 */
export const builtinAgents: Readonly<Record<string, AgentConfig>> = {
  claude: {
    name: "claude",
    command: "claude",
    args: ["-p"],
    continueArgs: ["--continue"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "Anthropic Claude Code",
    capabilities: ["code-edit", "reasoning", "code-review", "explain"],
    priority: 10,
  },

  codex: {
    name: "codex",
    command: "codex",
    args: ["exec"],
    streamFormat: "json-lines",
    contextInjection: "prompt-prefix",
    description: "OpenAI Codex CLI",
    capabilities: ["code-edit", "fast"],
    priority: 8,
  },

  gemini: {
    name: "gemini",
    command: "gemini",
    args: ["-p"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "Google Gemini CLI",
    capabilities: ["reasoning", "explain", "fast"],
    priority: 7,
  },

  goose: {
    name: "goose",
    command: "goose",
    args: ["run", "--no-session", "-t"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "Block Goose",
    capabilities: ["code-edit", "reasoning"],
    priority: 6,
  },

  aider: {
    name: "aider",
    command: "aider",
    args: ["--message"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "Aider (open source)",
    capabilities: ["code-edit"],
    priority: 5,
  },

  copilot: {
    name: "copilot",
    command: "copilot",
    args: ["-p"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "GitHub Copilot CLI",
    capabilities: ["code-edit", "fast"],
    priority: 5,
  },

  opencode: {
    name: "opencode",
    command: "opencode",
    args: ["run"],
    continueArgs: ["-c"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "OpenCode",
    capabilities: ["code-edit", "reasoning"],
    priority: 5,
  },

  gptme: {
    name: "gptme",
    command: "gptme",
    args: ["--non-interactive"],
    streamFormat: "text",
    contextInjection: "prompt-prefix",
    description: "gptme",
    capabilities: ["code-edit"],
    priority: 4,
  },
}

/**
 * Detect which agents are available on the system.
 */
export async function detectAvailableAgents(): Promise<string[]> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  const available: string[] = []

  for (const [name, config] of Object.entries(builtinAgents)) {
    try {
      await execFileAsync("which", [config.command])
      available.push(name)
    } catch {
      // Agent not installed — skip
    }
  }

  return available
}
