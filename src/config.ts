import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { AmbientConfig, TemplateConfig } from "./types/index.js"
import { builtinAgents } from "./agents/registry.js"

export const builtinTemplates: Readonly<Record<string, TemplateConfig>> = {
  review: {
    command: "git diff",
    prompt: "Review these changes. Focus on bugs, security issues, and code quality. Be concise.",
    description: "Review unstaged git changes",
  },
  "review-staged": {
    command: "git diff --cached",
    prompt: "Review these staged changes. Focus on bugs, security issues, and code quality. Be concise.",
    description: "Review staged git changes",
  },
  fix: {
    prompt: "Fix the error from the last failed command. Show me the corrected code and explain what went wrong.",
    description: "Fix the last failed command",
  },
  test: {
    prompt: "Write tests for the specified files using the project's test framework and conventions.",
    description: "Generate tests for files",
  },
  explain: {
    prompt: "Explain what this code does, focusing on key design decisions and potential issues.",
    description: "Explain code or output",
  },
  commit: {
    command: "git diff --cached",
    prompt: "Write a concise commit message for these staged changes. Output only the commit message — no explanation, no markdown fences.",
    description: "Generate commit message for staged changes",
  },
}

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

export function getLogPath(): string {
  return join(getAmbientDir(), "daemon.log")
}

export function loadConfig(): AmbientConfig {
  const configPath = getConfigPath()

  const defaults: AmbientConfig = {
    defaultAgent: "claude",
    agents: builtinAgents,
    templates: builtinTemplates,
    maxRecentCommands: 50,
    socketPath: getSocketPath(),
    logLevel: "info",
    privacy: {
      localOnly: false,
      passiveMonitoring: true,
      ignoreFile: "",
    },
  }

  if (!existsSync(configPath)) {
    return defaults
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(raw) as Partial<AmbientConfig>
    return {
      ...defaults,
      ...userConfig,
      // Merge templates: user templates override builtins
      templates: { ...builtinTemplates, ...userConfig.templates },
    }
  } catch {
    return defaults
  }
}
