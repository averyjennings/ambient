/**
 * LLM provider abstraction layer.
 *
 * Supports Anthropic (default), Ollama (local), and any OpenAI-compatible
 * endpoint. Each provider implements streaming and non-streaming calls
 * with provider-specific wire formats.
 */

import { loadConfig } from "../config.js"

// --- Public interfaces ---

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  model: string
}

export interface LlmStreamResult {
  ok: boolean
  usage?: UsageInfo
}

export interface LlmCallResult {
  text: string | null
  usage?: UsageInfo
}

export interface LlmProvider {
  stream(prompt: string, onChunk: (text: string) => void, system?: string): Promise<LlmStreamResult>
  call(prompt: string, maxTokens?: number, system?: string): Promise<LlmCallResult>
}

export interface LlmProviderConfig {
  provider: "anthropic" | "ollama" | "openai-compat"
  model?: string
  apiKey?: string
  baseUrl?: string
  maxTokens?: number
}

// --- Shared helpers ---

function logError(msg: string): void {
  process.stderr.write(`[ambient] ${msg}\n`)
}

// --- Anthropic provider ---

const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
const ANTHROPIC_STREAM_TIMEOUT = 60_000
const ANTHROPIC_CALL_TIMEOUT = 15_000

export function parseAnthropicSseLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6)
  if (data === "[DONE]") return null

  try {
    const event = JSON.parse(data) as {
      type?: string
      delta?: { type?: string; text?: string }
    }
    if (event.type === "content_block_delta" && event.delta?.text) {
      return event.delta.text
    }
  } catch {
    // ignore partial JSON
  }
  return null
}

class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxTokens: number

  constructor(config: LlmProviderConfig) {
    this.apiKey = config.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? ""
    this.model = config.model ?? ANTHROPIC_DEFAULT_MODEL
    this.baseUrl = config.baseUrl ?? ANTHROPIC_DEFAULT_URL
    this.maxTokens = config.maxTokens ?? 8192
  }

  async stream(prompt: string, onChunk: (text: string) => void, system?: string): Promise<LlmStreamResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANTHROPIC_STREAM_TIMEOUT)

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          stream: true,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const errorBody = response.body ? await response.text().catch(() => "") : ""
        logError(`Anthropic API error: ${response.status} ${errorBody.slice(0, 200)}`)
        return { ok: false }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let inputTokens = 0
      let outputTokens = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const text = parseAnthropicSseLine(line)
          if (text !== null) onChunk(text)

          // Parse usage from SSE events
          if (line.startsWith("data: ")) {
            const data = line.slice(6)
            if (data !== "[DONE]") {
              try {
                const event = JSON.parse(data) as {
                  type?: string
                  message?: { usage?: { input_tokens?: number } }
                  usage?: { output_tokens?: number }
                }
                if (event.type === "message_start" && event.message?.usage?.input_tokens) {
                  inputTokens = event.message.usage.input_tokens
                }
                if (event.type === "message_delta" && event.usage?.output_tokens) {
                  outputTokens = event.usage.output_tokens
                }
              } catch {
                // ignore parse errors for usage extraction
              }
            }
          }
        }
      }

      const usage = (inputTokens > 0 || outputTokens > 0)
        ? { inputTokens, outputTokens, model: this.model }
        : undefined

      return { ok: true, usage }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`Anthropic stream error: ${msg}`)
      return { ok: false }
    } finally {
      clearTimeout(timeout)
    }
  }

  async call(prompt: string, maxTokens?: number, system?: string): Promise<LlmCallResult> {
    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens ?? this.maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(ANTHROPIC_CALL_TIMEOUT),
      })

      if (!response.ok) return { text: null }

      const result = await response.json() as {
        content?: Array<{ type: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const text = result.content?.find((c) => c.type === "text")?.text ?? null
      const usage = result.usage
        ? { inputTokens: result.usage.input_tokens ?? 0, outputTokens: result.usage.output_tokens ?? 0, model: this.model }
        : undefined

      return { text, usage }
    } catch {
      return { text: null }
    }
  }
}

// --- Ollama provider ---

const OLLAMA_DEFAULT_URL = "http://localhost:11434/api/chat"
const OLLAMA_DEFAULT_MODEL = "llama3.2"
const OLLAMA_STREAM_TIMEOUT = 120_000
const OLLAMA_CALL_TIMEOUT = 60_000

export function parseOllamaJsonLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const obj = JSON.parse(trimmed) as {
      message?: { content?: string }
      done?: boolean
    }
    if (obj.done) return null
    return obj.message?.content ?? null
  } catch {
    return null
  }
}

class OllamaProvider implements LlmProvider {
  private readonly model: string
  private readonly baseUrl: string

  constructor(config: LlmProviderConfig) {
    this.model = config.model ?? OLLAMA_DEFAULT_MODEL
    this.baseUrl = config.baseUrl ?? OLLAMA_DEFAULT_URL
  }

  async stream(prompt: string, onChunk: (text: string) => void, system?: string): Promise<LlmStreamResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), OLLAMA_STREAM_TIMEOUT)

    try {
      const messages: Array<{ role: string; content: string }> = []
      if (system) messages.push({ role: "system", content: system })
      messages.push({ role: "user", content: prompt })

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, stream: true }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const errorBody = response.body ? await response.text().catch(() => "") : ""
        logError(`Ollama API error: ${response.status} ${errorBody.slice(0, 200)}`)
        return { ok: false }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const text = parseOllamaJsonLine(line)
          if (text !== null) onChunk(text)
        }
      }

      return { ok: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`Ollama stream error: ${msg}`)
      return { ok: false }
    } finally {
      clearTimeout(timeout)
    }
  }

  async call(prompt: string, maxTokens?: number, system?: string): Promise<LlmCallResult> {
    try {
      const messages: Array<{ role: string; content: string }> = []
      if (system) messages.push({ role: "system", content: system })
      messages.push({ role: "user", content: prompt })

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(maxTokens ? { options: { num_predict: maxTokens } } : {}),
        }),
        signal: AbortSignal.timeout(OLLAMA_CALL_TIMEOUT),
      })

      if (!response.ok) return { text: null }

      const result = await response.json() as {
        message?: { content?: string }
      }
      return { text: result.message?.content ?? null }
    } catch {
      return { text: null }
    }
  }
}

// --- OpenAI-compatible provider ---

const OPENAI_DEFAULT_MODEL = "gpt-4o-mini"
const OPENAI_STREAM_TIMEOUT = 60_000
const OPENAI_CALL_TIMEOUT = 15_000

export function parseOpenAiSseLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null

  try {
    const obj = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>
    }
    return obj.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

class OpenAICompatProvider implements LlmProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxTokens: number

  constructor(config: LlmProviderConfig) {
    this.apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"] ?? ""
    this.model = config.model ?? OPENAI_DEFAULT_MODEL
    this.baseUrl = config.baseUrl ?? ""
    this.maxTokens = config.maxTokens ?? 4096
  }

  async stream(prompt: string, onChunk: (text: string) => void, system?: string): Promise<LlmStreamResult> {
    if (!this.baseUrl) {
      logError("OpenAI-compat provider requires a baseUrl")
      return { ok: false }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), OPENAI_STREAM_TIMEOUT)

    try {
      const messages: Array<{ role: string; content: string }> = []
      if (system) messages.push({ role: "system", content: system })
      messages.push({ role: "user", content: prompt })

      const url = this.baseUrl.endsWith("/chat/completions")
        ? this.baseUrl
        : `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          stream: true,
          messages,
        }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const errorBody = response.body ? await response.text().catch(() => "") : ""
        logError(`OpenAI-compat API error: ${response.status} ${errorBody.slice(0, 200)}`)
        return { ok: false }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const text = parseOpenAiSseLine(line)
          if (text !== null) onChunk(text)
        }
      }

      return { ok: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`OpenAI-compat stream error: ${msg}`)
      return { ok: false }
    } finally {
      clearTimeout(timeout)
    }
  }

  async call(prompt: string, maxTokens?: number, system?: string): Promise<LlmCallResult> {
    if (!this.baseUrl) return { text: null }

    try {
      const messages: Array<{ role: string; content: string }> = []
      if (system) messages.push({ role: "system", content: system })
      messages.push({ role: "user", content: prompt })

      const url = this.baseUrl.endsWith("/chat/completions")
        ? this.baseUrl
        : `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens ?? this.maxTokens,
          messages,
        }),
        signal: AbortSignal.timeout(OPENAI_CALL_TIMEOUT),
      })

      if (!response.ok) return { text: null }

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return { text: result.choices?.[0]?.message?.content ?? null }
    } catch {
      return { text: null }
    }
  }
}

// --- Factory ---

export function createProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider(config)
    case "openai-compat":
      return new OpenAICompatProvider(config)
    case "anthropic":
    default:
      return new AnthropicProvider(config)
  }
}

/**
 * Resolve provider config from the ambient config file.
 * Returns null if the chosen provider requires an API key and none is available.
 */
export function resolveProviderConfig(): LlmProviderConfig | null {
  const config = loadConfig()
  const llm = config.llm

  const providerType = llm?.provider ?? "anthropic"

  const resolved: LlmProviderConfig = {
    provider: providerType,
    model: llm?.model,
    apiKey: llm?.apiKey,
    baseUrl: llm?.baseUrl,
    maxTokens: llm?.maxTokens,
  }

  // Validate that required credentials are present
  switch (providerType) {
    case "anthropic": {
      const key = resolved.apiKey ?? process.env["ANTHROPIC_API_KEY"]
      if (!key) return null
      resolved.apiKey = key
      break
    }
    case "openai-compat": {
      const key = resolved.apiKey ?? process.env["OPENAI_API_KEY"]
      if (!key) return null
      resolved.apiKey = key
      break
    }
    case "ollama":
      // No key needed
      break
  }

  return resolved
}
