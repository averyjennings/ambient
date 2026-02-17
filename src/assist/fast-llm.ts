/**
 * Direct LLM call for instant shell assistance.
 *
 * Instead of spawning a full agent CLI as a subprocess (cold start + heavy),
 * this delegates to a provider abstraction that supports Anthropic, Ollama,
 * and any OpenAI-compatible endpoint. Uses a fast/cheap model for speed.
 *
 * Supports streaming — first tokens arrive in ~200-300ms vs waiting ~1s
 * for the full response. This makes the assist feel instant.
 *
 * Provider is resolved from config (~/.ambient/config.json) with Anthropic
 * as the default. Falls back to ANTHROPIC_API_KEY in the environment.
 */

import type { LlmProvider } from "./providers.js"
import { createProvider, resolveProviderConfig } from "./providers.js"
import type { UsageTracker, UsagePurpose } from "../usage/tracker.js"

export const MAX_TOKENS = 4096
export const COMPACT_MAX_TOKENS = 8192
export const STREAM_TIMEOUT_MS = 60_000

// Lazy singleton — created on first use, reset via resetProvider()
let _provider: LlmProvider | null = null
let _providerResolved = false

// Optional usage tracker — set by daemon on startup
let _usageTracker: UsageTracker | null = null

/**
 * Set the usage tracker for recording token usage and enforcing budgets.
 * Called once during daemon startup.
 */
export function setUsageTracker(tracker: UsageTracker): void {
  _usageTracker = tracker
}

function log(level: string, msg: string): void {
  process.stderr.write(`[ambient] [${level}] ${msg}\n`)
}

/**
 * Resolve the LLM provider from config on first call.
 * Returns null if the provider requires an API key and none is available.
 */
function getProvider(): LlmProvider | null {
  if (_providerResolved) return _provider

  _providerResolved = true
  const config = resolveProviderConfig()
  if (!config) {
    _provider = null
    return null
  }

  _provider = createProvider(config)
  return _provider
}

/**
 * Reset the provider singleton. Call this when config may have changed
 * (e.g. after the user edits ~/.ambient/config.json).
 */
export function resetProvider(): void {
  _provider = null
  _providerResolved = false
}

/**
 * Stream an LLM response, calling onChunk for each text token.
 * First tokens arrive in ~200-300ms with Anthropic. Returns false
 * if the provider is unavailable or the call fails.
 */
export async function streamFastLlm(
  prompt: string,
  onChunk: (text: string) => void,
  system?: string,
  purpose?: UsagePurpose,
): Promise<boolean> {
  const provider = getProvider()
  if (!provider) return false

  // Budget check before making the API call
  if (_usageTracker) {
    const budget = _usageTracker.checkBudget()
    if (!budget.allowed) {
      log("warn", `Daily budget exceeded. Skipping API call.`)
      return false
    }
    if (budget.warning) {
      log("warn", budget.warning)
    }
  }

  const result = await provider.stream(prompt, onChunk, system)

  // Record usage if tracker is active and we have usage data
  if (_usageTracker && purpose && result.usage) {
    _usageTracker.record({
      timestamp: Date.now(),
      model: result.usage.model,
      purpose,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })
  }

  return result.ok
}

/**
 * Non-streaming LLM call. Collects all tokens and returns the full
 * response text. Used by memory compaction.
 *
 * Returns null if the provider is unavailable or the call fails.
 */
export async function callFastLlm(
  prompt: string,
  maxTokens?: number,
  system?: string,
  purpose?: UsagePurpose,
): Promise<string | null> {
  const provider = getProvider()
  if (!provider) return null

  // Budget check before making the API call
  if (_usageTracker) {
    const budget = _usageTracker.checkBudget()
    if (!budget.allowed) {
      log("warn", `Daily budget exceeded. Skipping API call.`)
      return null
    }
    if (budget.warning) {
      log("warn", budget.warning)
    }
  }

  const result = await provider.call(prompt, maxTokens, system)

  // Record usage if tracker is active and we have usage data
  if (_usageTracker && purpose && result.usage) {
    _usageTracker.record({
      timestamp: Date.now(),
      model: result.usage.model,
      purpose,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })
  }

  return result.text
}
