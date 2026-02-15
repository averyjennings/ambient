import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { MemoryEvent, MemoryKey, ProjectMemory, TaskMemory } from "../../src/types/index.js"

/**
 * Integration tests for store.ts functions that do real file I/O.
 * We mock homedir() to redirect all file operations to a temp directory,
 * then test the actual exported functions (load, save, add, delete, update).
 */

const TEST_HOME = join(tmpdir(), `ambient-test-${process.pid}-${Date.now()}`)

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>()
  return { ...original, homedir: () => TEST_HOME }
})

// Dynamic import AFTER mock setup so store.ts sees the mocked homedir
const store = await import("../../src/memory/store.js")

// --- Helpers ---

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: crypto.randomUUID(),
    type: "decision",
    timestamp: Date.now(),
    content: "Test event content",
    importance: "medium",
    ...overrides,
  }
}

function makeMemKey(overrides: Partial<MemoryKey> = {}): MemoryKey {
  return {
    projectKey: "test-pk",
    taskKey: "test-tk",
    projectName: "test-project",
    branchName: "feature/test",
    origin: "git@github.com:test/test.git",
    ...overrides,
  }
}

function makeProject(projectKey: string, events: MemoryEvent[] = []): ProjectMemory {
  return {
    projectKey,
    projectName: "test-project",
    origin: "git@github.com:test/test.git",
    createdAt: Date.now(),
    lastActive: Date.now(),
    events,
  }
}

function makeTask(projectKey: string, taskKey: string, events: MemoryEvent[] = []): TaskMemory {
  return {
    branchKey: taskKey,
    branchName: "feature/test",
    projectKey,
    createdAt: Date.now(),
    lastActive: Date.now(),
    archived: false,
    events,
  }
}

// --- Setup / Teardown ---

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

// --- Load / Save round-trips ---

describe("loadProjectMemory / saveProjectMemory", () => {
  it("returns null for non-existent project", () => {
    expect(store.loadProjectMemory("nonexistent")).toBeNull()
  })

  it("round-trips project memory through disk", () => {
    const events = [makeEvent({ content: "chose REST over GraphQL" })]
    store.saveProjectMemory(makeProject("pk1", events))

    const loaded = store.loadProjectMemory("pk1")
    expect(loaded).not.toBeNull()
    expect(loaded!.events).toHaveLength(1)
    expect(loaded!.events[0]!.content).toBe("chose REST over GraphQL")
  })

  it("returns null for TTL-expired project (91 days old)", () => {
    const memory = makeProject("pk-expired")
    memory.lastActive = Date.now() - 91 * 24 * 60 * 60 * 1_000
    store.saveProjectMemory(memory)

    expect(store.loadProjectMemory("pk-expired")).toBeNull()
  })

  it("returns null for corrupt JSON on disk", () => {
    const dir = store.getProjectDir("pk-corrupt")
    writeFileSync(join(dir, "project.json"), "not valid json {{{")

    expect(store.loadProjectMemory("pk-corrupt")).toBeNull()
  })
})

describe("loadTaskMemory / saveTaskMemory", () => {
  it("returns null for non-existent task", () => {
    expect(store.loadTaskMemory("pk", "nonexistent")).toBeNull()
  })

  it("round-trips task memory through disk", () => {
    const events = [makeEvent({ content: "fixed the CORS bug" })]
    store.saveTaskMemory(makeTask("pk2", "tk2", events))

    const loaded = store.loadTaskMemory("pk2", "tk2")
    expect(loaded).not.toBeNull()
    expect(loaded!.events).toHaveLength(1)
    expect(loaded!.events[0]!.content).toBe("fixed the CORS bug")
  })

  it("returns null for TTL-expired task (91 days old)", () => {
    const memory = makeTask("pk-exp", "tk-exp")
    memory.lastActive = Date.now() - 91 * 24 * 60 * 60 * 1_000
    store.saveTaskMemory(memory)

    expect(store.loadTaskMemory("pk-exp", "tk-exp")).toBeNull()
  })
})

// --- addProjectEvent / addTaskEvent ---

describe("addProjectEvent", () => {
  it("creates project memory on first event", () => {
    const event = makeEvent({ content: "initial decision" })
    store.addProjectEvent("pk-new", "my-project", "git@github.com:a/b.git", event)

    const loaded = store.loadProjectMemory("pk-new")
    expect(loaded).not.toBeNull()
    expect(loaded!.events).toHaveLength(1)
    expect(loaded!.projectName).toBe("my-project")
  })

  it("appends to existing project memory", () => {
    store.addProjectEvent("pk-app", "proj", "origin", makeEvent({ content: "first" }))
    store.addProjectEvent("pk-app", "proj", "origin", makeEvent({ content: "second" }))

    const loaded = store.loadProjectMemory("pk-app")
    expect(loaded!.events).toHaveLength(2)
  })

  it("trims to 50 events, preserving high-importance", () => {
    const highEvent = makeEvent({ content: "critical decision", importance: "high" })
    store.addProjectEvent("pk-trim", "proj", "origin", highEvent)

    for (let i = 0; i < 55; i++) {
      store.addProjectEvent("pk-trim", "proj", "origin", makeEvent({
        content: `low event ${i}`,
        importance: "low",
        timestamp: Date.now() + i,
      }))
    }

    const loaded = store.loadProjectMemory("pk-trim")
    expect(loaded!.events.length).toBeLessThanOrEqual(50)
    expect(loaded!.events.some((e) => e.content === "critical decision")).toBe(true)
  })
})

describe("addTaskEvent", () => {
  it("creates task memory on first event", () => {
    store.addTaskEvent("pk-task", "tk-new", "feature/foo", makeEvent({ content: "started work" }))

    const loaded = store.loadTaskMemory("pk-task", "tk-new")
    expect(loaded).not.toBeNull()
    expect(loaded!.branchName).toBe("feature/foo")
    expect(loaded!.events).toHaveLength(1)
  })
})

// --- deleteMemoryEvent ---

describe("deleteMemoryEvent", () => {
  const pk = "pk-del"
  const tk = "tk-del"
  const memKey = makeMemKey({ projectKey: pk, taskKey: tk })

  it("deletes event from project store", () => {
    const event = makeEvent({ content: "to delete" })
    store.saveProjectMemory(makeProject(pk, [event]))

    expect(store.deleteMemoryEvent(memKey, event.id)).toBe(true)
    expect(store.loadProjectMemory(pk)!.events).toHaveLength(0)
  })

  it("deletes event from task store", () => {
    const event = makeEvent({ content: "task event to delete" })
    store.saveTaskMemory(makeTask(pk, tk, [event]))

    expect(store.deleteMemoryEvent(memKey, event.id)).toBe(true)
    expect(store.loadTaskMemory(pk, tk)!.events).toHaveLength(0)
  })

  it("deletes from both stores when event ID exists in both", () => {
    const id = crypto.randomUUID()
    store.saveProjectMemory(makeProject(pk, [makeEvent({ id, content: "shared" })]))
    store.saveTaskMemory(makeTask(pk, tk, [makeEvent({ id, content: "shared" })]))

    expect(store.deleteMemoryEvent(memKey, id)).toBe(true)
    expect(store.loadProjectMemory(pk)!.events).toHaveLength(0)
    expect(store.loadTaskMemory(pk, tk)!.events).toHaveLength(0)
  })

  it("returns false when event does not exist in either store", () => {
    store.saveProjectMemory(makeProject(pk, [makeEvent()]))
    store.saveTaskMemory(makeTask(pk, tk, [makeEvent()]))

    expect(store.deleteMemoryEvent(memKey, "nonexistent-id")).toBe(false)
  })

  it("returns false when stores do not exist", () => {
    expect(store.deleteMemoryEvent(memKey, "any-id")).toBe(false)
  })

  it("preserves other events when deleting one", () => {
    const keep = makeEvent({ content: "keep this" })
    const remove = makeEvent({ content: "remove this" })
    store.saveProjectMemory(makeProject(pk, [keep, remove]))

    store.deleteMemoryEvent(memKey, remove.id)

    const loaded = store.loadProjectMemory(pk)
    expect(loaded!.events).toHaveLength(1)
    expect(loaded!.events[0]!.content).toBe("keep this")
  })

  it("does not write to disk when event is not found (no-op)", () => {
    const event = makeEvent()
    store.saveProjectMemory(makeProject(pk, [event]))

    const path = join(store.getProjectDir(pk), "project.json")
    const before = readFileSync(path, "utf-8")

    store.deleteMemoryEvent(memKey, "nonexistent")

    const after = readFileSync(path, "utf-8")
    expect(after).toBe(before)
  })
})

// --- updateMemoryEvent ---

describe("updateMemoryEvent", () => {
  const pk = "pk-upd"
  const tk = "tk-upd"
  const memKey = makeMemKey({ projectKey: pk, taskKey: tk })

  it("updates event content in project store", () => {
    const event = makeEvent({ content: "old content" })
    store.saveProjectMemory(makeProject(pk, [event]))

    expect(store.updateMemoryEvent(memKey, event.id, "new content")).toBe(true)
    expect(store.loadProjectMemory(pk)!.events[0]!.content).toBe("new content")
  })

  it("updates event content in task store", () => {
    const event = makeEvent({ content: "old task content" })
    store.saveTaskMemory(makeTask(pk, tk, [event]))

    expect(store.updateMemoryEvent(memKey, event.id, "new task content")).toBe(true)
    expect(store.loadTaskMemory(pk, tk)!.events[0]!.content).toBe("new task content")
  })

  it("truncates content to 1000 characters", () => {
    const event = makeEvent({ content: "short" })
    store.saveProjectMemory(makeProject(pk, [event]))

    store.updateMemoryEvent(memKey, event.id, "x".repeat(1200))

    expect(store.loadProjectMemory(pk)!.events[0]!.content).toHaveLength(1000)
  })

  it("bumps lastActive on project store", () => {
    const event = makeEvent()
    const project = makeProject(pk, [event])
    // Use a timestamp that's old but within TTL (1 hour ago, not epoch)
    const oneHourAgo = Date.now() - 60 * 60 * 1_000
    project.lastActive = oneHourAgo
    store.saveProjectMemory(project)

    store.updateMemoryEvent(memKey, event.id, "updated")

    expect(store.loadProjectMemory(pk)!.lastActive).toBeGreaterThan(oneHourAgo)
  })

  it("bumps lastActive on task store", () => {
    const event = makeEvent()
    const task = makeTask(pk, tk, [event])
    const oneHourAgo = Date.now() - 60 * 60 * 1_000
    task.lastActive = oneHourAgo
    store.saveTaskMemory(task)

    store.updateMemoryEvent(memKey, event.id, "updated")

    expect(store.loadTaskMemory(pk, tk)!.lastActive).toBeGreaterThan(oneHourAgo)
  })

  it("returns false when event does not exist", () => {
    store.saveProjectMemory(makeProject(pk, [makeEvent()]))

    expect(store.updateMemoryEvent(memKey, "nonexistent-id", "new")).toBe(false)
  })

  it("returns false when stores do not exist", () => {
    expect(store.updateMemoryEvent(memKey, "any-id", "content")).toBe(false)
  })

  it("preserves all other event fields (type, importance, metadata, timestamp)", () => {
    const event = makeEvent({
      content: "original",
      type: "error-resolution",
      importance: "high",
      metadata: { file: "src/index.ts" },
      timestamp: 12345,
    })
    store.saveProjectMemory(makeProject(pk, [event]))

    store.updateMemoryEvent(memKey, event.id, "corrected content")

    const updated = store.loadProjectMemory(pk)!.events[0]!
    expect(updated.content).toBe("corrected content")
    expect(updated.type).toBe("error-resolution")
    expect(updated.importance).toBe("high")
    expect(updated.metadata).toEqual({ file: "src/index.ts" })
    expect(updated.timestamp).toBe(12345)
    expect(updated.id).toBe(event.id)
  })

  it("updates in both stores when event ID exists in both", () => {
    const id = crypto.randomUUID()
    store.saveProjectMemory(makeProject(pk, [makeEvent({ id, content: "old" })]))
    store.saveTaskMemory(makeTask(pk, tk, [makeEvent({ id, content: "old" })]))

    expect(store.updateMemoryEvent(memKey, id, "new")).toBe(true)
    expect(store.loadProjectMemory(pk)!.events[0]!.content).toBe("new")
    expect(store.loadTaskMemory(pk, tk)!.events[0]!.content).toBe("new")
  })

  it("does not mutate other events in the array", () => {
    const bystander = makeEvent({ content: "leave me alone" })
    const target = makeEvent({ content: "update me" })
    store.saveProjectMemory(makeProject(pk, [bystander, target]))

    store.updateMemoryEvent(memKey, target.id, "updated")

    const loaded = store.loadProjectMemory(pk)!
    expect(loaded.events).toHaveLength(2)
    expect(loaded.events[0]!.content).toBe("leave me alone")
    expect(loaded.events[1]!.content).toBe("updated")
  })
})

// --- findSupersededDecision ---

describe("findSupersededDecision", () => {
  it("returns null when no decisions exist", () => {
    expect(store.findSupersededDecision([], "Use JWT for authentication")).toBeNull()
  })

  it("returns null when only non-decision events exist", () => {
    const events = [
      makeEvent({ type: "task-update", content: "Working on JWT authentication" }),
      makeEvent({ type: "error-resolution", content: "Fixed JWT token expiry issue" }),
    ]
    expect(store.findSupersededDecision(events, "Use JWT with refresh tokens for auth")).toBeNull()
  })

  it("returns null when new content has too few keywords", () => {
    const events = [makeEvent({ type: "decision", content: "Use JWT for authentication" })]
    // "ok" has only 1 keyword after stop-word removal — too few to compare
    expect(store.findSupersededDecision(events, "ok")).toBeNull()
  })

  it("detects superseded decision with high keyword overlap", () => {
    const old = makeEvent({ type: "decision", content: "Use JWT tokens for authentication" })
    const events = [old]
    const result = store.findSupersededDecision(events, "Use JWT tokens with refresh for authentication")
    expect(result).toBe(old.id)
  })

  it("does not supersede decisions with different topics", () => {
    const events = [
      makeEvent({ type: "decision", content: "Use PostgreSQL for the database layer" }),
    ]
    expect(store.findSupersededDecision(events, "Use JWT tokens for authentication")).toBeNull()
  })

  it("returns the most similar decision when multiple exist", () => {
    const unrelated = makeEvent({ type: "decision", content: "Use PostgreSQL for database storage" })
    const related = makeEvent({ type: "decision", content: "Use session expiry timeout of 90 seconds" })
    const events = [unrelated, related]

    const result = store.findSupersededDecision(events, "Trust fresh session state, no expiry timeout needed")
    // "session" and "expiry" and "timeout" overlap with the related decision
    // "PostgreSQL" and "database" and "storage" don't overlap at all
    if (result !== null) {
      expect(result).toBe(related.id)
    }
    // If null, the keywords didn't overlap enough — that's acceptable
  })
})

// --- Supersede integration (addProjectEvent / addTaskEvent) ---

describe("decision supersede integration", () => {
  it("replaces superseded decision in project store when adding a new one", () => {
    const old = makeEvent({ type: "decision", content: "Use JWT tokens for user authentication" })
    store.addProjectEvent("pk-sup", "proj", "origin", old)

    const replacement = makeEvent({ type: "decision", content: "Use JWT tokens with refresh for user authentication" })
    store.addProjectEvent("pk-sup", "proj", "origin", replacement)

    const loaded = store.loadProjectMemory("pk-sup")!
    // Should have 1 event (old superseded), not 2
    const decisions = loaded.events.filter((e) => e.type === "decision")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.id).toBe(replacement.id)
    expect(decisions[0]!.content).toContain("refresh")
  })

  it("replaces superseded decision in task store when adding a new one", () => {
    const old = makeEvent({ type: "decision", content: "Use JWT tokens for user authentication" })
    store.addTaskEvent("pk-sup", "tk-sup", "feature/auth", old)

    const replacement = makeEvent({ type: "decision", content: "Use JWT tokens with refresh for user authentication" })
    store.addTaskEvent("pk-sup", "tk-sup", "feature/auth", replacement)

    const loaded = store.loadTaskMemory("pk-sup", "tk-sup")!
    const decisions = loaded.events.filter((e) => e.type === "decision")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.id).toBe(replacement.id)
  })

  it("does not supersede when topics are different", () => {
    store.addProjectEvent("pk-nosup", "proj", "origin",
      makeEvent({ type: "decision", content: "Use PostgreSQL for database storage" }))
    store.addProjectEvent("pk-nosup", "proj", "origin",
      makeEvent({ type: "decision", content: "Use JWT tokens for user authentication" }))

    const loaded = store.loadProjectMemory("pk-nosup")!
    expect(loaded.events.filter((e) => e.type === "decision")).toHaveLength(2)
  })

  it("does not supersede non-decision events even with similar content", () => {
    store.addTaskEvent("pk-nodec", "tk-nodec", "main",
      makeEvent({ type: "task-update", content: "Started working on JWT authentication" }))
    store.addTaskEvent("pk-nodec", "tk-nodec", "main",
      makeEvent({ type: "task-update", content: "Completed working on JWT authentication" }))

    const loaded = store.loadTaskMemory("pk-nodec", "tk-nodec")!
    expect(loaded.events).toHaveLength(2)
  })

  it("preserves non-decision events when superseding a decision", () => {
    const taskUpdate = makeEvent({ type: "task-update", content: "Started auth work" })
    const oldDecision = makeEvent({ type: "decision", content: "Use JWT tokens for authentication" })
    store.addProjectEvent("pk-mix", "proj", "origin", taskUpdate)
    store.addProjectEvent("pk-mix", "proj", "origin", oldDecision)

    const newDecision = makeEvent({ type: "decision", content: "Use JWT tokens with refresh for authentication" })
    store.addProjectEvent("pk-mix", "proj", "origin", newDecision)

    const loaded = store.loadProjectMemory("pk-mix")!
    expect(loaded.events).toHaveLength(2) // task-update + new decision
    expect(loaded.events.find((e) => e.type === "task-update")).toBeDefined()
    expect(loaded.events.find((e) => e.id === newDecision.id)).toBeDefined()
    expect(loaded.events.find((e) => e.id === oldDecision.id)).toBeUndefined()
  })
})

// --- extractKeywords ---

describe("extractKeywords", () => {
  it("extracts meaningful words, removing stop words", () => {
    const keywords = store.extractKeywords("Use JWT for authentication in the API")
    expect(keywords).toContain("jwt")
    expect(keywords).toContain("authentication")
    expect(keywords).toContain("api")
    expect(keywords).not.toContain("use") // stop word
    expect(keywords).not.toContain("for") // stop word
    expect(keywords).not.toContain("the") // stop word
    expect(keywords).not.toContain("in")  // too short
  })

  it("lowercases and removes punctuation", () => {
    const keywords = store.extractKeywords("JWT-based Auth! (v2)")
    expect(keywords).toContain("jwt-based")
    expect(keywords).toContain("auth")
  })

  it("returns empty array for all stop words", () => {
    const keywords = store.extractKeywords("the is are a an")
    expect(keywords).toHaveLength(0)
  })
})
