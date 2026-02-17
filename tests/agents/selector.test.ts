import { describe, it, expect } from "vitest"
import { selectAgent } from "../../src/agents/selector.js"
import { builtinAgents } from "../../src/agents/registry.js"

describe("selectAgent", () => {
  // Use all builtin agent names as the installed set for most tests
  const allAgents = Object.keys(builtinAgents)

  it("selects agent with code-edit capability for 'fix this bug'", () => {
    const result = selectAgent("fix this bug", allAgents, "claude")
    const config = builtinAgents[result]
    expect(config?.capabilities).toContain("code-edit")
  })

  it("selects agent with explain capability for 'explain this'", () => {
    const result = selectAgent("explain this", allAgents, "claude")
    const config = builtinAgents[result]
    expect(config?.capabilities).toContain("explain")
  })

  it("selects agent with code-review capability for 'review the code'", () => {
    const result = selectAgent("review the code", allAgents, "claude")
    const config = builtinAgents[result]
    expect(config?.capabilities).toContain("code-review")
  })

  it("returns default agent for empty query", () => {
    const result = selectAgent("", allAgents, "claude")
    expect(result).toBe("claude")
  })

  it("returns default agent when no agents are installed", () => {
    const result = selectAgent("fix this bug", [], "claude")
    expect(result).toBe("claude")
  })

  it("returns default agent when query has no matching signals", () => {
    // Random words that don't match any intent signals
    const result = selectAgent("banana orange grape", allAgents, "claude")
    expect(result).toBe("claude")
  })

  it("higher priority agent wins among equally specialized agents", () => {
    // Both goose and opencode have capabilities: ["code-edit", "reasoning"]
    // goose has priority 6, opencode has priority 5.
    // For "edit" query, both match code-edit with same specialization ratio (1/2).
    // goose should win due to higher priority.
    const result = selectAgent("edit the file", ["goose", "opencode"], "gemini")
    expect(result).toBe("goose")
  })

  it("specialization bonus: agent with fewer but matching caps scores higher", () => {
    // "edit" targets code-edit only.
    // aider has capabilities: ["code-edit"] (1 cap, 100% match)
    // claude has capabilities: ["code-edit", "reasoning", "code-review", "explain"] (4 caps, 25% match)
    // Specialization ratio for aider = 1/1 = 1.0, for claude = 1/4 = 0.25
    // aider score: 1 (keyword) + 1.0*0.5 (specialization) + 5*0.01 (priority) = 1.55
    // claude score: 1 (keyword) + 0.25*0.5 (specialization) + 10*0.01 (priority) = 1.225
    // aider should win
    const result = selectAgent("edit", ["aider", "claude"], "claude")
    expect(result).toBe("aider")
  })

  it("selects reasoning-capable agent for 'think about the design'", () => {
    const result = selectAgent("think about the design", allAgents, "claude")
    const config = builtinAgents[result]
    expect(config?.capabilities).toContain("reasoning")
  })

  it("handles multiple matching capabilities correctly", () => {
    // "explain and review" should match both explain and code-review
    const result = selectAgent("explain and review", allAgents, "codex")
    const config = builtinAgents[result]
    // Claude has both explain and code-review capabilities
    expect(config?.capabilities).toContain("explain")
    expect(config?.capabilities).toContain("code-review")
  })

  it("uses default agent name, not first installed, for unknown queries", () => {
    const result = selectAgent("xyzzy plugh", ["codex", "gemini"], "codex")
    expect(result).toBe("codex")
  })
})
