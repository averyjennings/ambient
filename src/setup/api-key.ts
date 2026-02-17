export interface ApiKeyStatus {
  found: boolean
  source: "env" | "none"
  valid: boolean | null // null = not checked
}

export function checkApiKey(): ApiKeyStatus {
  const key = process.env["ANTHROPIC_API_KEY"]
  if (key) return { found: true, source: "env", valid: null }
  return { found: false, source: "none", valid: null }
}

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    // 200 = valid, 401 = invalid, anything else = assume valid (network issue)
    return resp.status !== 401
  } catch {
    return true // Assume valid if network fails
  }
}
