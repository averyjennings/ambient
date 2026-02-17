import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  createProvider,
  parseAnthropicSseLine,
  parseOllamaJsonLine,
  parseOpenAiSseLine,
  resolveProviderConfig,
} from "../../src/assist/providers.js"
import type { LlmProviderConfig } from "../../src/assist/providers.js"

// --- Pure parsing function tests ---

describe("parseAnthropicSseLine", () => {
  it("extracts text from content_block_delta events", () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}'
    expect(parseAnthropicSseLine(line)).toBe("Hello")
  })

  it("returns null for non-data lines", () => {
    expect(parseAnthropicSseLine("event: message_start")).toBeNull()
    expect(parseAnthropicSseLine("")).toBeNull()
  })

  it("returns null for [DONE] sentinel", () => {
    expect(parseAnthropicSseLine("data: [DONE]")).toBeNull()
  })

  it("returns null for non-content events", () => {
    const line = 'data: {"type":"message_start","message":{"id":"msg_1"}}'
    expect(parseAnthropicSseLine(line)).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseAnthropicSseLine("data: {broken")).toBeNull()
  })
})

describe("parseOllamaJsonLine", () => {
  it("extracts content from message objects", () => {
    const line = '{"message":{"content":"world"},"done":false}'
    expect(parseOllamaJsonLine(line)).toBe("world")
  })

  it("returns null for done:true lines", () => {
    const line = '{"message":{"content":""},"done":true}'
    expect(parseOllamaJsonLine(line)).toBeNull()
  })

  it("returns null for empty lines", () => {
    expect(parseOllamaJsonLine("")).toBeNull()
    expect(parseOllamaJsonLine("   ")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseOllamaJsonLine("{broken")).toBeNull()
  })
})

describe("parseOpenAiSseLine", () => {
  it("extracts content from delta objects", () => {
    const line = 'data: {"choices":[{"delta":{"content":"token"}}]}'
    expect(parseOpenAiSseLine(line)).toBe("token")
  })

  it("returns null for [DONE] sentinel", () => {
    expect(parseOpenAiSseLine("data: [DONE]")).toBeNull()
  })

  it("returns null for non-data lines", () => {
    expect(parseOpenAiSseLine("event: message")).toBeNull()
    expect(parseOpenAiSseLine("")).toBeNull()
  })

  it("returns null when delta has no content", () => {
    const line = 'data: {"choices":[{"delta":{}}]}'
    expect(parseOpenAiSseLine(line)).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseOpenAiSseLine("data: {broken")).toBeNull()
  })
})

// --- Factory tests ---

describe("createProvider", () => {
  it("creates an anthropic provider by default", () => {
    const config: LlmProviderConfig = { provider: "anthropic", apiKey: "test-key" }
    const provider = createProvider(config)
    expect(provider).toBeDefined()
    expect(provider.stream).toBeInstanceOf(Function)
    expect(provider.call).toBeInstanceOf(Function)
  })

  it("creates an ollama provider", () => {
    const config: LlmProviderConfig = { provider: "ollama" }
    const provider = createProvider(config)
    expect(provider).toBeDefined()
    expect(provider.stream).toBeInstanceOf(Function)
    expect(provider.call).toBeInstanceOf(Function)
  })

  it("creates an openai-compat provider", () => {
    const config: LlmProviderConfig = {
      provider: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
    }
    const provider = createProvider(config)
    expect(provider).toBeDefined()
    expect(provider.stream).toBeInstanceOf(Function)
    expect(provider.call).toBeInstanceOf(Function)
  })
})

// --- Config resolution tests ---

describe("resolveProviderConfig", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env["ANTHROPIC_API_KEY"]
    delete process.env["OPENAI_API_KEY"]
    // Mock loadConfig to return defaults (no llm field)
    vi.mock("../../src/config.js", () => ({
      loadConfig: vi.fn(() => ({
        defaultAgent: "claude",
        agents: {},
        templates: {},
        maxRecentCommands: 50,
        socketPath: "/tmp/test.sock",
        logLevel: "info",
      })),
    }))
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it("returns null when anthropic is default and no API key is set", () => {
    const result = resolveProviderConfig()
    expect(result).toBeNull()
  })

  it("returns config when ANTHROPIC_API_KEY env var is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test"
    const result = resolveProviderConfig()
    expect(result).not.toBeNull()
    expect(result?.provider).toBe("anthropic")
    expect(result?.apiKey).toBe("sk-ant-test")
  })
})

// --- Provider HTTP tests with mocked fetch ---

describe("AnthropicProvider streaming", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("streams text from SSE events", async () => {
    const sseBody = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
      "data: [DONE]",
      "",
    ].join("\n")

    const mockBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody))
        controller.close()
      },
    })

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
      text: () => Promise.resolve(""),
    })

    const provider = createProvider({ provider: "anthropic", apiKey: "test" })
    const chunks: string[] = []
    const result = await provider.stream("test prompt", (text) => chunks.push(text))

    expect(result.ok).toBe(true)
    expect(chunks).toEqual(["Hello", " world"])
  })

  it("returns false on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
      text: () => Promise.resolve("Unauthorized"),
    })

    const provider = createProvider({ provider: "anthropic", apiKey: "bad-key" })
    const result = await provider.stream("test", () => {})
    expect(result.ok).toBe(false)
  })
})

describe("OllamaProvider non-streaming", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("returns content from non-streaming response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: "Ollama says hello" } }),
    })

    const provider = createProvider({ provider: "ollama" })
    const result = await provider.call("test prompt")

    expect(result.text).toBe("Ollama says hello")
  })
})

describe("OpenAICompatProvider streaming", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("streams text from OpenAI SSE events", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"content":" there"}}]}',
      "data: [DONE]",
      "",
    ].join("\n")

    const mockBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody))
        controller.close()
      },
    })

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
      text: () => Promise.resolve(""),
    })

    const provider = createProvider({
      provider: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
    })
    const chunks: string[] = []
    const result = await provider.stream("test prompt", (text) => chunks.push(text))

    expect(result.ok).toBe(true)
    expect(chunks).toEqual(["Hi", " there"])
  })
})
