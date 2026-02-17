import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import type { DaemonResponse } from "../../src/types/index.js"
import type { RouteOptions } from "../../src/agents/router.js"

// Mock pty-spawn before importing router
vi.mock("../../src/agents/pty-spawn.js", () => ({
  spawnWithPty: vi.fn(),
  stripPtyArtifacts: vi.fn((text: string) => text),
}))

import { spawnWithPty } from "../../src/agents/pty-spawn.js"
import { routeToAgent } from "../../src/agents/router.js"

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess
  ;(proc as Record<string, unknown>).stdout = new Readable({ read() {} })
  ;(proc as Record<string, unknown>).stderr = new Readable({ read() {} })
  ;(proc as Record<string, unknown>).pid = 12345
  ;(proc as Record<string, unknown>).killed = false
  ;(proc as Record<string, unknown>).kill = vi.fn()
  return proc
}

function createRouteOptions(overrides?: Partial<RouteOptions>): RouteOptions {
  return {
    continueSession: false,
    onChunk: vi.fn(),
    ...overrides,
  }
}

describe("routeToAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports error for unknown agent name", async () => {
    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const result = await routeToAgent("test prompt", "nonexistent-agent", "", options)

    expect(result.fullResponse).toBe("")
    expect(chunks.some((c) => c.type === "error" && c.data.includes("Unknown agent"))).toBe(true)
    expect(chunks.some((c) => c.type === "done")).toBe(true)
  })

  it("lists available agents in the error message for unknown agent", async () => {
    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    await routeToAgent("test", "bad-agent", "", options)

    const errorChunk = chunks.find((c) => c.type === "error")
    expect(errorChunk?.data).toContain("claude")
    expect(errorChunk?.data).toContain("codex")
  })

  it("spawns process with correct command for known agent", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions()

    // Start the route (it will wait for the process to close)
    const resultPromise = routeToAgent("test prompt", "claude", "", options)

    // Simulate process closing
    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    expect(spawnWithPty).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p"]),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
  })

  it("passes stdout chunks to onChunk callback", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const resultPromise = routeToAgent("test", "claude", "", options)

    // Simulate stdout data
    process.nextTick(() => {
      mockProc.stdout!.emit("data", Buffer.from("Hello "))
      mockProc.stdout!.emit("data", Buffer.from("world"))
      mockProc.emit("close", 0)
    })

    const result = await resultPromise

    const textChunks = chunks.filter((c) => c.type === "chunk")
    expect(textChunks.length).toBe(2)
    expect(textChunks[0]!.data).toBe("Hello ")
    expect(textChunks[1]!.data).toBe("world")
    expect(result.fullResponse).toBe("Hello world")
  })

  it("passes stderr chunks to onChunk callback", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const resultPromise = routeToAgent("test", "claude", "", options)

    process.nextTick(() => {
      mockProc.stderr!.emit("data", Buffer.from("progress info"))
      mockProc.emit("close", 0)
    })

    await resultPromise

    const chunkMessages = chunks.filter((c) => c.type === "chunk")
    expect(chunkMessages.some((c) => c.data === "progress info")).toBe(true)
  })

  it("collects full response and returns it", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions()

    const resultPromise = routeToAgent("test", "claude", "", options)

    process.nextTick(() => {
      mockProc.stdout!.emit("data", Buffer.from("part1"))
      mockProc.stdout!.emit("data", Buffer.from("part2"))
      mockProc.emit("close", 0)
    })

    const result = await resultPromise
    expect(result.fullResponse).toBe("part1part2")
  })

  it("reports error for non-zero exit code", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const resultPromise = routeToAgent("test", "claude", "", options)

    process.nextTick(() => {
      mockProc.emit("close", 1)
    })

    await resultPromise

    expect(chunks.some((c) => c.type === "error" && c.data.includes("exited with code 1"))).toBe(true)
    expect(chunks.some((c) => c.type === "done")).toBe(true)
  })

  it("does not report error for null exit code (signal kill)", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const resultPromise = routeToAgent("test", "claude", "", options)

    process.nextTick(() => {
      mockProc.emit("close", null)
    })

    await resultPromise

    // Should still emit "done" but no error for null exit code
    expect(chunks.filter((c) => c.type === "error")).toEqual([])
    expect(chunks.some((c) => c.type === "done")).toBe(true)
  })

  it("enriches prompt with context block for first message", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions({ continueSession: false })

    const resultPromise = routeToAgent("what is this?", "claude", "cwd: /home\ngit: main", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    // The enriched prompt should include the context block
    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    const prompt = args[args.length - 1]!
    expect(prompt).toContain("cwd: /home")
    expect(prompt).toContain("git: main")
    expect(prompt).toContain("what is this?")
  })

  it("skips context block for continuation when agent has continueArgs", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    // claude has continueArgs defined
    const options = createRouteOptions({ continueSession: true })

    const resultPromise = routeToAgent("follow up question", "claude", "cwd: /home", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    const prompt = args[args.length - 1]!
    // Should NOT contain context block
    expect(prompt).not.toContain("[Shell context]")
    expect(prompt).toBe("follow up question")
  })

  it("appends continueArgs when continuing a session", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions({ continueSession: true })

    const resultPromise = routeToAgent("follow up", "claude", "", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    // claude.continueArgs is ["--continue"]
    expect(args).toContain("--continue")
  })

  it("does not append continueArgs for agents without them", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    // codex has no continueArgs
    const options = createRouteOptions({ continueSession: true })

    const resultPromise = routeToAgent("test", "codex", "context", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    expect(args).not.toContain("--continue")
  })

  it("reports spawn failure (ENOENT) as error", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const chunks: DaemonResponse[] = []
    const options = createRouteOptions({
      onChunk: (resp) => chunks.push(resp),
    })

    const resultPromise = routeToAgent("test", "claude", "", options)

    process.nextTick(() => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      mockProc.emit("error", err)
    })

    await resultPromise

    const errorChunks = chunks.filter((c) => c.type === "error")
    expect(errorChunks.length).toBeGreaterThan(0)
    expect(errorChunks[0]!.data).toContain("Failed to spawn agent")
    expect(errorChunks[0]!.data).toContain("ENOENT")
    expect(chunks.some((c) => c.type === "done")).toBe(true)
  })

  it("includes context in enriched prompt when not empty", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions({ continueSession: false })

    const resultPromise = routeToAgent("help me", "codex", "some context here", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    const prompt = args[args.length - 1]!
    expect(prompt).toContain("some context here")
    expect(prompt).toContain("[Shell context]")
    expect(prompt).toContain("help me")
  })

  it("uses plain prompt when context block is empty", async () => {
    const mockProc = createMockProcess()
    vi.mocked(spawnWithPty).mockReturnValue(mockProc)

    const options = createRouteOptions({ continueSession: false })

    const resultPromise = routeToAgent("just a question", "claude", "", options)

    process.nextTick(() => {
      mockProc.emit("close", 0)
    })

    await resultPromise

    const spawnCall = vi.mocked(spawnWithPty).mock.calls[0]!
    const args = spawnCall[1] as string[]
    const prompt = args[args.length - 1]!
    // Empty context means no [Shell context] block
    expect(prompt).toBe("just a question")
  })
})
