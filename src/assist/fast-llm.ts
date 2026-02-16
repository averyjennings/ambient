/**
 * Direct LLM call for instant shell assistance.
 *
 * Instead of spawning a full agent CLI as a subprocess (cold start + heavy),
 * this calls the Anthropic API directly using fetch(). Uses Haiku for speed.
 *
 * Supports streaming — first tokens arrive in ~200-300ms vs waiting ~1s
 * for the full response. This makes the assist feel instant.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */

const API_URL = "https://api.anthropic.com/v1/messages"
const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 8192
const COMPACT_MAX_TOKENS = 8192

/**
 * Stream a Haiku response, calling onChunk for each text token.
 * First tokens arrive in ~200-300ms. Returns false if the API key
 * is missing or the call fails.
 */
export async function streamFastLlm(
  prompt: string,
  onChunk: (text: string) => void,
): Promise<boolean> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]
  if (!apiKey) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok || !response.body) {
      const errorBody = response.body ? await response.text().catch(() => "") : ""
      process.stderr.write(`[ambient] Haiku API error: ${response.status} ${errorBody.slice(0, 200)}\n`)
      return false
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
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6)
        if (data === "[DONE]") return true

        try {
          const event = JSON.parse(data) as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          if (event.type === "content_block_delta" && event.delta?.text) {
            onChunk(event.delta.text)
          }
        } catch {
          // ignore partial JSON
        }
      }
    }

    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[ambient] Haiku stream error: ${msg}\n`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Non-streaming wrapper around streamFastLlm. Collects all tokens
 * and returns the full response text. Used by memory compaction.
 *
 * Uses a higher max_tokens limit (500) for compaction summaries.
 * Returns null if the API key is missing or the call fails.
 */
export async function callFastLlm(prompt: string, maxTokens?: number): Promise<string | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]
  if (!apiKey) return null

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens ?? COMPACT_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) return null

    const result = await response.json() as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = result.content?.find((c) => c.type === "text")?.text
    return text ?? null
  } catch {
    return null
  }
}
