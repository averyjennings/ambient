import { builtinAgents } from "./registry.js"

/**
 * Keyword groups that map query intent to agent capabilities.
 * Each group has a set of trigger words and the capability they suggest.
 */
const intentSignals: ReadonlyArray<{ keywords: readonly string[]; capability: string }> = [
  {
    keywords: ["fix", "edit", "change", "refactor", "update", "modify", "add", "remove", "delete", "rename", "move", "write", "implement", "create"],
    capability: "code-edit",
  },
  {
    keywords: ["explain", "what", "why", "how", "describe", "understand", "tell", "show", "mean"],
    capability: "explain",
  },
  {
    keywords: ["review", "check", "audit", "analyze", "inspect", "look"],
    capability: "code-review",
  },
  {
    keywords: ["think", "reason", "plan", "design", "architect", "decide", "compare", "tradeoff"],
    capability: "reasoning",
  },
]

/**
 * Select the best agent for a query based on keyword analysis and
 * agent capabilities. Only considers installed agents.
 *
 * Returns the agent name, or null to fall back to the default.
 */
export function selectAgent(
  query: string,
  installedAgents: readonly string[],
  defaultAgent: string,
): string {
  if (installedAgents.length === 0) return defaultAgent

  const queryLower = query.toLowerCase()
  const words = queryLower.split(/\s+/)

  // Score each capability based on keyword matches
  const capabilityScores = new Map<string, number>()
  for (const signal of intentSignals) {
    for (const keyword of signal.keywords) {
      if (words.includes(keyword)) {
        const current = capabilityScores.get(signal.capability) ?? 0
        capabilityScores.set(signal.capability, current + 1)
      }
    }
  }

  // If no signals detected, fall back to default
  if (capabilityScores.size === 0) return defaultAgent

  // Score each installed agent
  let bestAgent = defaultAgent
  let bestScore = -1

  for (const name of installedAgents) {
    const config = builtinAgents[name]
    if (!config?.capabilities) continue

    let score = 0
    for (const cap of config.capabilities) {
      score += capabilityScores.get(cap) ?? 0
    }

    // Weight by agent priority
    score += (config.priority ?? 0) * 0.1

    if (score > bestScore) {
      bestScore = score
      bestAgent = name
    }
  }

  return bestAgent
}
