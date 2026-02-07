import { spawn } from "node:child_process"
import type { AgentConfig, DaemonResponse } from "../types/index.js"
import { builtinAgents } from "./registry.js"

/**
 * The agent router invokes any coding agent as a subprocess,
 * injects ambient context into the prompt, and streams output
 * back to the caller via a callback.
 */
export async function routeToAgent(
  prompt: string,
  agentName: string,
  contextBlock: string,
  onChunk: (response: DaemonResponse) => void,
  signal?: AbortSignal,
): Promise<void> {
  const config = builtinAgents[agentName]
  if (!config) {
    onChunk({ type: "error", data: `Unknown agent: ${agentName}. Available: ${Object.keys(builtinAgents).join(", ")}` })
    onChunk({ type: "done", data: "" })
    return
  }

  const enrichedPrompt = buildEnrichedPrompt(prompt, contextBlock, config)
  const args = [...config.args, enrichedPrompt]

  await new Promise<void>((resolve) => {
    const child = spawn(config.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    const cleanup = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM")
      }
    }

    signal?.addEventListener("abort", cleanup, { once: true })

    child.stdout.on("data", (data: Buffer) => {
      onChunk({ type: "chunk", data: data.toString() })
    })

    child.stderr.on("data", (data: Buffer) => {
      // Some agents emit progress on stderr — forward it
      onChunk({ type: "chunk", data: data.toString() })
    })

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        onChunk({ type: "error", data: `Agent '${agentName}' exited with code ${code}` })
      }
      onChunk({ type: "done", data: "" })
      signal?.removeEventListener("abort", cleanup)
      resolve()
    })

    child.on("error", (err) => {
      onChunk({
        type: "error",
        data: `Failed to spawn agent '${agentName}': ${err.message}. Is '${config.command}' installed?`,
      })
      onChunk({ type: "done", data: "" })
      resolve()
    })
  })
}

function buildEnrichedPrompt(
  userPrompt: string,
  contextBlock: string,
  _config: AgentConfig,
): string {
  if (!contextBlock) {
    return userPrompt
  }

  return `[Shell Context]
${contextBlock}

[Task]
${userPrompt}`
}
