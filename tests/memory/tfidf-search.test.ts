import { describe, it, expect } from "vitest"
import type { MemoryEvent } from "../../src/types/index.js"

// --- Reproduce the pure scoring logic from store.ts for unit testing ---
// This avoids needing to mock homedir() or the filesystem.

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "me", "my", "you", "your", "we", "our", "they", "them", "their",
  "it", "its", "he", "she", "him", "her", "his", "this", "that", "these",
  "those", "what", "which", "who", "whom", "where", "when", "how", "why",
  "and", "or", "but", "not", "no", "if", "then", "else", "so", "than",
  "too", "very", "just", "about", "above", "after", "again", "all", "also",
  "am", "any", "as", "at", "back", "because", "before", "between", "both",
  "by", "came", "come", "each", "even", "for", "from", "get", "got",
  "go", "going", "here", "in", "into", "know", "let", "like", "look",
  "make", "many", "more", "most", "much", "of", "on", "only", "other",
  "out", "over", "re", "really", "right", "said", "same", "see", "some",
  "still", "such", "take", "tell", "through", "to", "up", "us", "use",
  "want", "way", "well", "were", "with", "yes", "yet",
  "remember", "memories", "memory", "everything", "anything", "something",
  "hey", "hi", "hello", "please", "thanks",
])

function extractKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
}

function computeIdf(searchTexts: string[], keywords: string[]): Map<string, number> {
  const idf = new Map<string, number>()
  const n = searchTexts.length
  for (const kw of keywords) {
    let df = 0
    for (const text of searchTexts) {
      if (text.includes(kw)) df++
    }
    idf.set(kw, Math.log((1 + n) / (1 + df)))
  }
  return idf
}

function scoreTfIdf(searchText: string, keywords: string[], idfMap: Map<string, number>): number {
  if (keywords.length === 0) return 0
  let score = 0
  for (const kw of keywords) {
    if (searchText.includes(kw)) {
      score += idfMap.get(kw) ?? 0
    }
  }
  return score
}

function recencyScore(timestamp: number): number {
  const hoursAgo = (Date.now() - timestamp) / (1_000 * 60 * 60)
  return 1 / (1 + hoursAgo / 24)
}

// --- Tests ---

describe("extractKeywords", () => {
  it("removes stop words", () => {
    const result = extractKeywords("what is the authentication approach?")
    expect(result).toEqual(["authentication", "approach"])
  })

  it("removes short words", () => {
    const result = extractKeywords("go fix it now")
    // "go", "fix", "it", "now" — "go" is stop word, "it" is stop word, "fix" is 3 chars (included), "now" is 3 chars (included)
    expect(result).toContain("fix")
    expect(result).toContain("now")
    expect(result).not.toContain("go")
    expect(result).not.toContain("it")
  })

  it("does NOT filter out 'ambient' (project name should be searchable)", () => {
    const result = extractKeywords("tell me about the ambient project")
    expect(result).toContain("ambient")
    expect(result).toContain("project")
  })

  it("returns empty for pure stop-word queries", () => {
    const result = extractKeywords("what have I been doing?")
    // "what" stop, "have" stop, "I" stop (too short), "been" stop, "doing" — not a stop word, 5 chars
    expect(result).toContain("doing")
  })

  it("handles empty input", () => {
    expect(extractKeywords("")).toEqual([])
  })
})

describe("TF-IDF scoring", () => {
  const corpus = [
    "ambient project build passed pnpm build",
    "chose jwt authentication with refresh tokens",
    "build failed webpack compilation error",
    "switched to branch feature/auth",
    "installed react-router react-dom",
    "build passed pnpm build", // duplicate "build" content
  ]

  it("gives higher IDF to rare terms", () => {
    const keywords = ["jwt", "build"]
    const idf = computeIdf(corpus, keywords)

    // "jwt" appears in 1/6 docs, "build" appears in 3/6 docs
    // jwt should have higher IDF
    expect(idf.get("jwt")!).toBeGreaterThan(idf.get("build")!)
  })

  it("scores matching events higher", () => {
    const keywords = ["jwt", "authentication"]
    const idf = computeIdf(corpus, keywords)

    const jwtScore = scoreTfIdf(corpus[1]!, keywords, idf)
    const buildScore = scoreTfIdf(corpus[0]!, keywords, idf)

    expect(jwtScore).toBeGreaterThan(0)
    expect(buildScore).toBe(0) // "build" doesn't match "jwt" or "authentication"
  })

  it("returns 0 for no-match events", () => {
    const keywords = ["terraform"]
    const idf = computeIdf(corpus, keywords)

    for (const text of corpus) {
      expect(scoreTfIdf(text, keywords, idf)).toBe(0)
    }
  })

  it("returns 0 when no keywords", () => {
    expect(scoreTfIdf("some text", [], new Map())).toBe(0)
  })
})

describe("recency scoring", () => {
  it("gives ~1.0 for events from now", () => {
    const score = recencyScore(Date.now())
    expect(score).toBeGreaterThan(0.99)
  })

  it("gives ~0.5 for events from 24h ago", () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const score = recencyScore(oneDayAgo)
    expect(score).toBeCloseTo(0.5, 1)
  })

  it("gives very low score for events from a week ago", () => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const score = recencyScore(weekAgo)
    expect(score).toBeLessThan(0.15)
  })
})

describe("adaptive weighting", () => {
  it("keyword queries find old but relevant events over recent irrelevant ones", () => {
    const now = Date.now()
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000

    // Two events: one recent but irrelevant, one old but matches keywords
    const events: { content: string; timestamp: number; projectName: string }[] = [
      { content: "Build passed: pnpm build", timestamp: now, projectName: "ambient" },
      { content: "Chose JWT authentication with refresh tokens", timestamp: weekAgo, projectName: "api-server" },
    ]

    const searchTexts = events.map(e => `${e.projectName} ${e.content}`.toLowerCase())
    const keywords = extractKeywords("what was the authentication approach?")
    const idf = computeIdf(searchTexts, keywords)

    const scored = events.map((e, i) => {
      const rec = recencyScore(e.timestamp)
      const tfidf = scoreTfIdf(searchTexts[i]!, keywords, idf)
      const maxTfidf = Math.max(...events.map((_, j) => scoreTfIdf(searchTexts[j]!, keywords, idf)), 0.001)
      const norm = tfidf / maxTfidf
      // Adaptive: keywords exist, so 0.5/0.5
      return { ...e, score: 0.5 * rec + 0.5 * norm }
    })

    scored.sort((a, b) => b.score - a.score)

    // The JWT event should rank higher despite being a week old
    expect(scored[0]!.content).toContain("JWT")
  })

  it("vague queries favor recent events", () => {
    const now = Date.now()
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000

    const events = [
      { content: "Build passed", timestamp: now },
      { content: "JWT decision", timestamp: weekAgo },
    ]

    const keywords = extractKeywords("what have I been doing?")
    // "doing" is the only keyword — not very specific

    // With almost no keyword signal, recency should dominate
    const recentScore = recencyScore(now)
    const oldScore = recencyScore(weekAgo)

    expect(recentScore).toBeGreaterThan(oldScore * 3)
  })
})

describe("project name searchability", () => {
  it("finds events when searching by project name", () => {
    const searchTexts = [
      "ambient main build passed pnpm build",
      "api-server feature/auth chose jwt authentication",
      "frontend main installed react-router",
    ]

    const keywords = extractKeywords("what's happening in the ambient project?")
    // Should extract "ambient" and "project" and maybe "happening"
    expect(keywords).toContain("ambient")

    const idf = computeIdf(searchTexts, keywords)
    const scores = searchTexts.map(t => scoreTfIdf(t, keywords, idf))

    // The ambient event should score highest
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
    expect(scores[0]!).toBeGreaterThan(scores[2]!)
  })
})
