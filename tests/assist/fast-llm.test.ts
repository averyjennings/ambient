import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { LlmProvider, LlmStreamResult, LlmCallResult } from "../../src/assist/providers.js"
import type { UsageTracker } from "../../src/usage/tracker.js"

// Mock the providers module
vi.mock("../../src/assist/providers.js", () => ({
  createProvider: vi.fn(),
  resolveProviderConfig: vi.fn(),
}))

import { createProvider, resolveProviderConfig } from "../../src/assist/providers.js"
import { streamFastLlm, callFastLlm, resetProvider, setUsageTracker } from "../../src/assist/fast-llm.js"

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    stream: vi.fn(async (_prompt: string, _onChunk: (text: string) => void, _system?: string): Promise<LlmStreamResult> => {
      return { ok: true, usage: { inputTokens: 100, outputTokens: 50, model: "test-model" } }
    }),
    call: vi.fn(async (_prompt: string, _maxTokens?: number, _system?: string): Promise<LlmCallResult> => {
      return { text: "test response", usage: { inputTokens: 100, outputTokens: 50, model: "test-model" } }
    }),
    ...overrides,
  }
}

describe("fast-llm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the lazy singleton between tests
    resetProvider()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- streamFastLlm ---

  describe("streamFastLlm", () => {
    it("returns false when no provider can be created (no API key)", async () => {
      vi.mocked(resolveProviderConfig).mockReturnValue(null)

      const chunks: string[] = []
      const result = await streamFastLlm("test prompt", (text) => chunks.push(text))

      expect(result).toBe(false)
      expect(chunks).toEqual([])
    })

    it("returns true when provider streams successfully", async () => {
      const mockProvider = createMockProvider({
        stream: vi.fn(async (_prompt, onChunk) => {
          onChunk("Hello")
          onChunk(" world")
          return { ok: true, usage: { inputTokens: 10, outputTokens: 5, model: "test" } }
        }),
      })

      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const chunks: string[] = []
      const result = await streamFastLlm("test prompt", (text) => chunks.push(text))

      expect(result).toBe(true)
      expect(chunks).toEqual(["Hello", " world"])
    })

    it("returns false when provider stream fails", async () => {
      const mockProvider = createMockProvider({
        stream: vi.fn(async () => ({ ok: false })),
      })

      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const result = await streamFastLlm("test prompt", () => {})
      expect(result).toBe(false)
    })

    it("passes system prompt to provider", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      await streamFastLlm("prompt", () => {}, "system instructions")

      expect(mockProvider.stream).toHaveBeenCalledWith("prompt", expect.any(Function), "system instructions")
    })

    it("uses cached provider on second call", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      await streamFastLlm("first", () => {})
      await streamFastLlm("second", () => {})

      // resolveProviderConfig and createProvider should only be called once
      expect(resolveProviderConfig).toHaveBeenCalledTimes(1)
      expect(createProvider).toHaveBeenCalledTimes(1)
    })
  })

  // --- callFastLlm ---

  describe("callFastLlm", () => {
    it("returns null when no provider can be created", async () => {
      vi.mocked(resolveProviderConfig).mockReturnValue(null)

      const result = await callFastLlm("test prompt")
      expect(result).toBeNull()
    })

    it("returns response text on success", async () => {
      const mockProvider = createMockProvider({
        call: vi.fn(async () => ({
          text: "The answer is 42",
          usage: { inputTokens: 10, outputTokens: 5, model: "test" },
        })),
      })

      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const result = await callFastLlm("what is the meaning?")
      expect(result).toBe("The answer is 42")
    })

    it("returns null when provider call returns null text", async () => {
      const mockProvider = createMockProvider({
        call: vi.fn(async () => ({ text: null })),
      })

      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const result = await callFastLlm("test")
      expect(result).toBeNull()
    })

    it("passes maxTokens and system to provider", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      await callFastLlm("prompt", 1024, "system prompt")

      expect(mockProvider.call).toHaveBeenCalledWith("prompt", 1024, "system prompt")
    })
  })

  // --- resetProvider ---

  describe("resetProvider", () => {
    it("clears the cached provider so a new one is created", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      await callFastLlm("first call")
      expect(createProvider).toHaveBeenCalledTimes(1)

      resetProvider()

      await callFastLlm("second call after reset")
      expect(createProvider).toHaveBeenCalledTimes(2)
      expect(resolveProviderConfig).toHaveBeenCalledTimes(2)
    })
  })

  // --- setUsageTracker ---

  describe("setUsageTracker", () => {
    it("records usage after a successful stream call", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const mockTracker = {
        record: vi.fn(),
        checkBudget: vi.fn(() => ({ allowed: true })),
      } as unknown as UsageTracker

      setUsageTracker(mockTracker)

      await streamFastLlm("test prompt", () => {}, undefined, "assist")

      expect(mockTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "test-model",
          purpose: "assist",
          inputTokens: 100,
          outputTokens: 50,
        }),
      )

      // Clean up the tracker by resetting provider (which also resets internal state)
      // We need to re-set the tracker to null for other tests. Since there is no
      // public unsetUsageTracker, we accept the global state.
    })

    it("records usage after a successful call", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const mockTracker = {
        record: vi.fn(),
        checkBudget: vi.fn(() => ({ allowed: true })),
      } as unknown as UsageTracker

      setUsageTracker(mockTracker)

      await callFastLlm("test prompt", undefined, undefined, "compact")

      expect(mockTracker.record).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "test-model",
          purpose: "compact",
        }),
      )
    })

    it("blocks API calls when budget is exceeded", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const mockTracker = {
        record: vi.fn(),
        checkBudget: vi.fn(() => ({ allowed: false, warning: "Budget exceeded" })),
      } as unknown as UsageTracker

      setUsageTracker(mockTracker)

      const streamResult = await streamFastLlm("test", () => {}, undefined, "assist")
      expect(streamResult).toBe(false)
      expect(mockProvider.stream).not.toHaveBeenCalled()

      resetProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const callResult = await callFastLlm("test", undefined, undefined, "compact")
      expect(callResult).toBeNull()
      expect(mockProvider.call).not.toHaveBeenCalled()
    })

    it("does not record usage when purpose is not provided", async () => {
      const mockProvider = createMockProvider()
      vi.mocked(resolveProviderConfig).mockReturnValue({ provider: "anthropic", apiKey: "test" })
      vi.mocked(createProvider).mockReturnValue(mockProvider)

      const mockTracker = {
        record: vi.fn(),
        checkBudget: vi.fn(() => ({ allowed: true })),
      } as unknown as UsageTracker

      setUsageTracker(mockTracker)

      // Call without a purpose
      await streamFastLlm("test", () => {})
      expect(mockTracker.record).not.toHaveBeenCalled()

      await callFastLlm("test")
      expect(mockTracker.record).not.toHaveBeenCalled()
    })
  })
})
