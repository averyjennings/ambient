import type { AgentConfig, DaemonResponse } from "../types/index.js"
import { builtinAgents } from "./registry.js"
import { spawnWithPty, stripPtyArtifacts } from "./pty-spawn.js"

export interface RouteOptions {
  /** Whether to continue the previous session (if the agent supports it) */
  continueSession: boolean
  /** Callback for each response chunk */
  onChunk: (response: DaemonResponse) => void
  /** Abort signal */
  signal?: AbortSignal
}

export interface RouteResult {
  /** The full text response collected from the agent */
  fullResponse: string
}

/**
 * The agent router invokes any coding agent as a subprocess,
 * injects ambient context into the prompt, and streams output
 * back to the caller via a callback.
 *
 * Returns the full response text for caching in the daemon.
 */
export async function routeToAgent(
  prompt: string,
  agentName: string,
  contextBlock: string,
  options: RouteOptions,
): Promise<RouteResult> {
  const config = builtinAgents[agentName]
  if (!config) {
    options.onChunk({ type: "error", data: `Unknown agent: ${agentName}. Available: ${Object.keys(builtinAgents).join(", ")}` })
    options.onChunk({ type: "done", data: "" })
    return { fullResponse: "" }
  }

  const enrichedPrompt = buildEnrichedPrompt(prompt, contextBlock, config, options.continueSession)
  const args = buildArgs(config, enrichedPrompt, options.continueSession)

  const responseChunks: string[] = []

  await new Promise<void>((resolve) => {
    const child = spawnWithPty(config.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    const cleanup = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM")
      }
    }

    options.signal?.addEventListener("abort", cleanup, { once: true })

    child.stdout?.on("data", (data: Buffer) => {
      const text = stripPtyArtifacts(data.toString())
      responseChunks.push(text)
      options.onChunk({ type: "chunk", data: text })
    })

    child.stderr?.on("data", (data: Buffer) => {
      // Some agents emit progress on stderr — forward it
      options.onChunk({ type: "chunk", data: stripPtyArtifacts(data.toString()) })
    })

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        options.onChunk({ type: "error", data: `Agent '${agentName}' exited with code ${code}` })
      }
      options.onChunk({ type: "done", data: "" })
      options.signal?.removeEventListener("abort", cleanup)
      resolve()
    })

    child.on("error", (err) => {
      options.onChunk({
        type: "error",
        data: `Failed to spawn agent '${agentName}': ${err.message}. Is '${config.command}' installed?`,
      })
      options.onChunk({ type: "done", data: "" })
      resolve()
    })
  })

  return { fullResponse: responseChunks.join("") }
}

function buildArgs(
  config: AgentConfig,
  enrichedPrompt: string,
  continueSession: boolean,
): string[] {
  const args = [...config.args]

  // Add continuation flag if the agent supports it and we have a session
  if (continueSession && config.continueArgs) {
    args.push(...config.continueArgs)
  }

  args.push(enrichedPrompt)
  return args
}

function buildEnrichedPrompt(
  userPrompt: string,
  contextBlock: string,
  _config: AgentConfig,
  continueSession: boolean,
): string {
  // When continuing a session with an agent that supports it natively,
  // skip the context block — the agent already has the conversation history.
  // Only inject context for the first message or agents without continuation.
  if (continueSession && _config.continueArgs) {
    return userPrompt
  }

  if (!contextBlock) {
    return userPrompt
  }

  return `[Ambient Shell Context — you have access to persistent memory and terminal state]
${contextBlock}

[Task]
${userPrompt}`
}
