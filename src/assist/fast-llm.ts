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
const MAX_TOKENS = 200

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
  const timeout = setTimeout(() => controller.abort(), 5000)

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

    if (!response.ok || !response.body) return false

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
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
