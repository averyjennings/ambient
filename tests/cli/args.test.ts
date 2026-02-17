import { describe, it, expect } from "vitest"
import { parseArgs } from "../../src/cli/parse-args.js"

describe("parseArgs", () => {
  // --- Daemon subcommands ---

  it("parses 'daemon start'", () => {
    const result = parseArgs(["daemon", "start"])
    expect(result.command).toBe("daemon")
    expect(result.subcommand).toBe("start")
  })

  it("parses 'daemon stop'", () => {
    const result = parseArgs(["daemon", "stop"])
    expect(result.command).toBe("daemon")
    expect(result.subcommand).toBe("stop")
  })

  it("parses 'daemon status'", () => {
    const result = parseArgs(["daemon", "status"])
    expect(result.command).toBe("daemon")
    expect(result.subcommand).toBe("status")
  })

  it("parses 'daemon' with no subcommand", () => {
    const result = parseArgs(["daemon"])
    expect(result.command).toBe("daemon")
    expect(result.subcommand).toBeUndefined()
  })

  // --- Simple commands ---

  it("parses 'setup'", () => {
    const result = parseArgs(["setup"])
    expect(result.command).toBe("setup")
  })

  it("parses 'mcp-serve'", () => {
    const result = parseArgs(["mcp-serve"])
    expect(result.command).toBe("mcp-serve")
  })

  it("parses 'agents'", () => {
    const result = parseArgs(["agents"])
    expect(result.command).toBe("agents")
  })

  it("parses 'templates'", () => {
    const result = parseArgs(["templates"])
    expect(result.command).toBe("templates")
  })

  it("parses 'memory'", () => {
    const result = parseArgs(["memory"])
    expect(result.command).toBe("memory")
  })

  it("parses 'config'", () => {
    const result = parseArgs(["config"])
    expect(result.command).toBe("config")
  })

  // --- Remember ---

  it("parses 'remember' with content", () => {
    const result = parseArgs(["remember", "chose", "JWT"])
    expect(result.command).toBe("remember")
    expect(result.prompt).toBe("chose JWT")
  })

  it("parses 'remember' with --type flag", () => {
    const result = parseArgs(["remember", "--type", "decision", "chose", "JWT"])
    expect(result.command).toBe("remember")
    expect(result.flags.type).toBe("decision")
    expect(result.prompt).toBe("chose JWT")
  })

  it("parses 'remember' with --importance flag", () => {
    const result = parseArgs(["remember", "--importance", "high", "critical"])
    expect(result.command).toBe("remember")
    expect(result.flags.importance).toBe("high")
    expect(result.prompt).toBe("critical")
  })

  it("parses 'remember' with both --type and --importance", () => {
    const result = parseArgs(["remember", "--type", "decision", "--importance", "high", "use", "JWT"])
    expect(result.command).toBe("remember")
    expect(result.flags.type).toBe("decision")
    expect(result.flags.importance).toBe("high")
    expect(result.prompt).toBe("use JWT")
  })

  // --- Agent flag ---

  it("parses --agent flag with prompt as query", () => {
    const result = parseArgs(["--agent", "codex", "fix", "the", "bug"])
    expect(result.command).toBe("query")
    expect(result.flags.agent).toBe("codex")
    expect(result.prompt).toBe("fix the bug")
  })

  it("parses -a short flag", () => {
    const result = parseArgs(["-a", "codex", "fix"])
    expect(result.command).toBe("query")
    expect(result.flags.agent).toBe("codex")
    expect(result.prompt).toBe("fix")
  })

  // --- New session ---

  it("parses --new flag", () => {
    const result = parseArgs(["--new", "start", "fresh"])
    expect(result.command).toBe("query")
    expect(result.flags.newSession).toBe(true)
    expect(result.prompt).toBe("start fresh")
  })

  it("parses -n short flag for new session", () => {
    const result = parseArgs(["-n", "hello"])
    expect(result.command).toBe("query")
    expect(result.flags.newSession).toBe(true)
    expect(result.prompt).toBe("hello")
  })

  // --- Help ---

  it("parses --help", () => {
    const result = parseArgs(["--help"])
    expect(result.command).toBe("help")
    expect(result.flags.help).toBe(true)
  })

  it("parses -h", () => {
    const result = parseArgs(["-h"])
    expect(result.command).toBe("help")
    expect(result.flags.help).toBe(true)
  })

  it("returns help for empty args", () => {
    const result = parseArgs([])
    expect(result.command).toBe("help")
    expect(result.flags.help).toBe(true)
  })

  // --- Compare ---

  it("parses 'compare' with agents and prompt", () => {
    const result = parseArgs(["compare", "-a", "claude,gemini", "explain", "this"])
    expect(result.command).toBe("compare")
    expect(result.flags.agent).toBe("claude,gemini")
    expect(result.prompt).toBe("explain this")
  })

  it("parses 'compare' with --agents long form", () => {
    const result = parseArgs(["compare", "--agents", "claude,codex", "fix", "it"])
    expect(result.command).toBe("compare")
    expect(result.flags.agent).toBe("claude,codex")
    expect(result.prompt).toBe("fix it")
  })

  it("parses 'compare' with prompt only (no agents flag)", () => {
    const result = parseArgs(["compare", "explain", "this"])
    expect(result.command).toBe("compare")
    expect(result.prompt).toBe("explain this")
    expect(result.flags.agent).toBeUndefined()
  })

  // --- Assist ---

  it("parses 'assist' with command and exit code", () => {
    const result = parseArgs(["assist", "pnpm build", "1"])
    expect(result.command).toBe("assist")
    expect(result.prompt).toBe("pnpm build")
    expect(result.args).toEqual(["pnpm build", "1"])
  })

  it("parses 'assist' with no args", () => {
    const result = parseArgs(["assist"])
    expect(result.command).toBe("assist")
    expect(result.prompt).toBeUndefined()
  })

  // --- Notify ---

  it("parses 'notify' with message", () => {
    const result = parseArgs(["notify", "build", "done"])
    expect(result.command).toBe("notify")
    expect(result.prompt).toBe("build done")
  })

  // --- Default: query mode ---

  it("treats unknown words as query prompt", () => {
    const result = parseArgs(["fix", "the", "bug"])
    expect(result.command).toBe("query")
    expect(result.prompt).toBe("fix the bug")
  })

  it("treats single word as query", () => {
    const result = parseArgs(["review"])
    expect(result.command).toBe("query")
    expect(result.prompt).toBe("review")
  })

  // --- Combined flags ---

  it("parses --agent and --new together", () => {
    const result = parseArgs(["--agent", "gemini", "--new", "refactor", "auth"])
    expect(result.command).toBe("query")
    expect(result.flags.agent).toBe("gemini")
    expect(result.flags.newSession).toBe(true)
    expect(result.prompt).toBe("refactor auth")
  })

  // --- Setup with --agents ---

  it("parses 'setup' with --agents flag", () => {
    const result = parseArgs(["setup", "--agents", "claude,codex"])
    expect(result.command).toBe("setup")
    expect(result.flags.agent).toBe("claude,codex")
  })

  it("parses 'setup' without --agents", () => {
    const result = parseArgs(["setup"])
    expect(result.command).toBe("setup")
    expect(result.flags.agent).toBeUndefined()
  })

  // --- Simple commands pass remaining args ---

  it("passes remaining args for simple commands", () => {
    const result = parseArgs(["capture", "some", "output"])
    expect(result.command).toBe("capture")
    expect(result.args).toEqual(["some", "output"])
  })

  it("passes remaining args for 'new'", () => {
    const result = parseArgs(["new", "project-name"])
    expect(result.command).toBe("new")
    expect(result.args).toEqual(["project-name"])
  })
})
