/**
 * Direct LLM call for instant shell assistance.
 *
 * Instead of spawning a full agent CLI as a subprocess (cold start + heavy),
 * this calls the Anthropic API directly using fetch(). Uses Haiku for speed —
 * typical response time is ~800ms vs 3-5s for a subprocess spawn.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */

const API_URL = "https://api.anthropic.com/v1/messages"
const MODEL = "claude-haiku-4-5-20251001"
const MAX_TOKENS = 200

export interface FastLlmResult {
  text: string
}

/**
 * Call Haiku directly for a fast shell-assist response.
 * Returns null if the API key is missing or the call fails.
 */
export async function callFastLlm(prompt: string): Promise<FastLlmResult | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]
  if (!apiKey) return null

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
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) return null

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>
    }

    const text = data.content
      ?.filter(block => block.type === "text")
      .map(block => block.text ?? "")
      .join("")

    if (!text) return null
    return { text }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
