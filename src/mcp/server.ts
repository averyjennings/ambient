import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { sendDaemonRequest } from "./daemon-client.js"
import { resolveMemoryKey } from "../memory/resolve.js"
import { formatMemoryForPrompt, loadProjectMemory, loadTaskMemory, addTaskEvent, addProjectEvent, deleteMemoryEvent, updateMemoryEvent, searchAllMemory } from "../memory/store.js"
import type { ShellContext, MemoryEvent } from "../types/index.js"

interface McpServerOptions {
  cwd: string
}

/**
 * Get live context from the daemon, with disk fallback.
 */
async function getContext(cwd: string): Promise<{
  context: ShellContext | null
  formatted: string
  memory: string | null
}> {
  const result = await sendDaemonRequest({
    type: "context-read",
    payload: { cwd },
  })

  if (result.ok && result.data) {
    try {
      const parsed = JSON.parse(result.data) as {
        context: ShellContext
        formattedContext: string
        memory: string | null
      }
      return {
        context: parsed.context,
        formatted: parsed.formattedContext,
        memory: parsed.memory,
      }
    } catch {
      // Parse error — fall through to fallback
    }
  }

  // Fallback: minimal context from filesystem
  const memKey = resolveMemoryKey(cwd)
  return {
    context: null,
    formatted: `Working directory: ${cwd}\n(daemon not running — limited context)`,
    memory: formatMemoryForPrompt(memKey),
  }
}

/**
 * Write a memory event via daemon IPC, falling back to direct disk write.
 */
async function writeMemoryEvent(
  cwd: string,
  eventType: MemoryEvent["type"],
  content: string,
  importance: MemoryEvent["importance"],
  metadata?: Record<string, string>,
): Promise<string> {
  const result = await sendDaemonRequest({
    type: "memory-store",
    payload: { cwd, eventType, content, importance, metadata },
  })

  if (result.ok) return "Memory recorded (via daemon)."

  // Fallback: write directly to disk when daemon is down
  const memKey = resolveMemoryKey(cwd)
  const event: MemoryEvent = {
    id: globalThis.crypto.randomUUID(),
    type: eventType,
    timestamp: Date.now(),
    content: content.slice(0, 500),
    importance,
    metadata,
  }

  if (importance === "high") {
    addProjectEvent(memKey.projectKey, memKey.projectName, memKey.origin, event)
  }
  addTaskEvent(memKey.projectKey, memKey.taskKey, memKey.branchName, event)

  return "Memory recorded (direct to disk — daemon not running)."
}

/**
 * Creates an MCP server that exposes ambient's memory and context
 * to agents. Communicates with the daemon for live context, reads
 * memory from disk as fallback.
 */
export function createAmbientMcpServer(options: McpServerOptions): McpServer {
  const { cwd } = options

  const server = new McpServer({
    name: "ambient",
    version: "0.2.0",
  })

  // --- Resources ---

  server.resource(
    "shell-context",
    "ambient://context",
    async () => {
      const { context, formatted } = await getContext(cwd)
      return {
        contents: [{
          uri: "ambient://context",
          mimeType: "application/json",
          text: context ? JSON.stringify(context, null, 2) : formatted,
        }],
      }
    },
  )

  server.resource(
    "command-history",
    "ambient://history",
    async () => {
      const { context } = await getContext(cwd)
      return {
        contents: [{
          uri: "ambient://history",
          mimeType: "application/json",
          text: JSON.stringify(context?.recentCommands ?? [], null, 2),
        }],
      }
    },
  )

  server.resource(
    "project-info",
    "ambient://project",
    async () => {
      const { context } = await getContext(cwd)
      return {
        contents: [{
          uri: "ambient://project",
          mimeType: "application/json",
          text: JSON.stringify({
            type: context?.projectType ?? null,
            info: context?.projectInfo ?? null,
            cwd,
          }, null, 2),
        }],
      }
    },
  )

  server.resource(
    "project-memory",
    "ambient://memory/project",
    async () => {
      const memKey = resolveMemoryKey(cwd)
      const project = loadProjectMemory(memKey.projectKey)
      return {
        contents: [{
          uri: "ambient://memory/project",
          mimeType: "application/json",
          text: JSON.stringify(project, null, 2),
        }],
      }
    },
  )

  server.resource(
    "task-memory",
    "ambient://memory/task",
    async () => {
      const memKey = resolveMemoryKey(cwd)
      const task = loadTaskMemory(memKey.projectKey, memKey.taskKey)
      return {
        contents: [{
          uri: "ambient://memory/task",
          mimeType: "application/json",
          text: JSON.stringify(task, null, 2),
        }],
      }
    },
  )

  // --- Read tools ---

  server.tool(
    "get_shell_context",
    "Get the current shell context including cwd, git state, last command, and project info",
    {},
    async () => {
      const { formatted, memory } = await getContext(cwd)
      const text = memory ? `${formatted}\n\n${memory}` : formatted
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "get_command_history",
    "Get recent command history with exit codes, optionally filtered to failures only",
    {
      failuresOnly: z.boolean().optional().describe("If true, only return commands that failed"),
      limit: z.number().optional().describe("Maximum number of commands to return (default: 20)"),
    },
    async ({ failuresOnly, limit }) => {
      const { context } = await getContext(cwd)
      let commands = [...(context?.recentCommands ?? [])]
      if (failuresOnly) {
        commands = commands.filter((c) => c.exitCode !== 0)
      }
      commands = commands.slice(-(limit ?? 20))
      return {
        content: [{
          type: "text" as const,
          text: commands.map((c) =>
            `[${new Date(c.timestamp).toISOString()}] ${c.command} → exit ${c.exitCode} (in ${c.cwd})`,
          ).join("\n") || "No commands recorded (daemon may not be running)",
        }],
      }
    },
  )

  server.tool(
    "get_project_info",
    "Get detected project type, available scripts/commands, package manager, and framework",
    {},
    async () => {
      const { context } = await getContext(cwd)
      if (!context?.projectInfo) {
        return { content: [{ type: "text" as const, text: "No project detected in current directory" }] }
      }
      const info = context.projectInfo
      const lines = [`Project type: ${info.type}`]
      if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`)
      if (info.framework) lines.push(`Framework: ${info.framework}`)
      if (info.scripts.length > 0) lines.push(`Available scripts: ${info.scripts.join(", ")}`)
      return { content: [{ type: "text" as const, text: lines.join("\n") }] }
    },
  )

  server.tool(
    "get_task_context",
    "Get merged project + task memory context for the current working directory and branch",
    {},
    async () => {
      // Try daemon first for freshest data
      const result = await sendDaemonRequest({
        type: "memory-read",
        payload: { cwd },
      })

      let text: string
      if (result.ok && result.data) {
        text = result.data
      } else {
        // Fallback: read from disk
        const memKey = resolveMemoryKey(cwd)
        text = formatMemoryForPrompt(memKey) ?? "No memory stored for this project/branch."
      }

      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "get_decisions",
    "Get decisions made for the current project and/or task",
    {
      scope: z.enum(["project", "task", "both"]).optional().describe("Which decisions to show (default: both)"),
    },
    async ({ scope }) => {
      const memKey = resolveMemoryKey(cwd)
      const effectiveScope = scope ?? "both"
      const lines: string[] = []

      if (effectiveScope === "project" || effectiveScope === "both") {
        const project = loadProjectMemory(memKey.projectKey)
        if (project) {
          const decisions = project.events.filter((e) => e.type === "decision")
          if (decisions.length > 0) {
            lines.push(`[Project: ${memKey.projectName}]`)
            for (const d of decisions) {
              lines.push(`- ${d.content}`)
            }
          }
        }
      }

      if (effectiveScope === "task" || effectiveScope === "both") {
        const task = loadTaskMemory(memKey.projectKey, memKey.taskKey)
        if (task) {
          const decisions = task.events.filter((e) => e.type === "decision")
          if (decisions.length > 0) {
            if (lines.length > 0) lines.push("")
            lines.push(`[Task: ${memKey.branchName}]`)
            for (const d of decisions) {
              lines.push(`- ${d.content}`)
            }
          }
        }
      }

      const text = lines.length > 0 ? lines.join("\n") : "No decisions recorded."
      return { content: [{ type: "text" as const, text }] }
    },
  )

  // --- Write tools ---

  server.tool(
    "store_decision",
    "Record an important decision about the project or current task. Persists across sessions.",
    {
      decision: z.string().describe("The decision that was made"),
      reasoning: z.string().optional().describe("Why this decision was made"),
    },
    async ({ decision, reasoning }) => {
      const content = reasoning ? `${decision} (Reason: ${reasoning})` : decision
      const text = await writeMemoryEvent(cwd, "decision", content, "high")
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "store_task_update",
    "Record a task status update for the current branch. Persists across sessions.",
    {
      description: z.string().describe("What is being worked on"),
      status: z.enum(["started", "in-progress", "completed", "blocked"]).optional().describe("Current status"),
    },
    async ({ description, status }) => {
      const content = status ? `[${status}] ${description}` : description
      const text = await writeMemoryEvent(cwd, "task-update", content, "medium")
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "store_error_resolution",
    "Record how an error was resolved, so future sessions can reference it.",
    {
      error: z.string().describe("The error that occurred"),
      resolution: z.string().describe("How it was resolved"),
      file: z.string().optional().describe("File where the error occurred"),
    },
    async ({ error, resolution, file }) => {
      const content = `Error: ${error}\nResolution: ${resolution}`
      const metadata = file ? { file } : undefined
      const text = await writeMemoryEvent(cwd, "error-resolution", content, "medium", metadata)
      return { content: [{ type: "text" as const, text }] }
    },
  )

  // --- New read tools ---

  server.tool(
    "get_recent_output",
    "Get the most recently captured command output (from `rc` wrapper or `r capture`). Useful for diagnosing errors when the user ran a build/test command.",
    {},
    async () => {
      const result = await sendDaemonRequest({
        type: "output-read",
        payload: {},
      })

      const text = (result.ok && result.data)
        ? result.data
        : "No captured output available (use `rc <command>` to capture output, or daemon may not be running)"
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "search_all_memory",
    "Search across ALL projects and branches for relevant memories using TF-IDF + recency scoring. Use this to recall decisions or context from other projects.",
    {
      query: z.string().describe("Search query — keywords about what you're looking for"),
      maxResults: z.number().optional().describe("Maximum results to return (default: 25)"),
    },
    async ({ query, maxResults }) => {
      // Try daemon first for freshest data
      const result = await sendDaemonRequest({
        type: "memory-search",
        payload: { query, maxEvents: maxResults },
      }, 5_000) // longer timeout for cross-project search

      if (result.ok && result.data) {
        return { content: [{ type: "text" as const, text: result.data }] }
      }

      // Fallback: search directly from disk
      const text = searchAllMemory(query, maxResults ?? 25) ?? "No matching memories found."
      return { content: [{ type: "text" as const, text }] }
    },
  )

  // --- Memory management tools ---

  server.tool(
    "update_memory",
    "Update the content of an existing memory event by its ID. Use to correct wrong decisions or update outdated information.",
    {
      eventId: z.string().describe("The ID of the memory event to update"),
      newContent: z.string().max(500).describe("The updated content to replace the existing content (max 500 chars)"),
    },
    async ({ eventId, newContent }) => {
      // Try daemon first (handles context file regeneration)
      const result = await sendDaemonRequest({
        type: "memory-update",
        payload: { cwd, eventId, newContent },
      })

      if (result.ok) {
        return { content: [{ type: "text" as const, text: "Memory updated successfully." }] }
      }

      // Fallback: update directly on disk when daemon is down
      const memKey = resolveMemoryKey(cwd)
      const updated = updateMemoryEvent(memKey, eventId, newContent)
      const text = updated
        ? "Memory updated (direct to disk — daemon not running)."
        : `Memory event not found: ${eventId}`
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "delete_memory",
    "Delete a memory event by its ID. Use to remove obsolete or incorrect memories.",
    {
      eventId: z.string().describe("The ID of the memory event to delete"),
    },
    async ({ eventId }) => {
      // Try daemon first (it handles context file regeneration)
      const result = await sendDaemonRequest({
        type: "memory-delete",
        payload: { cwd, eventId },
      })

      if (result.ok) {
        // Daemon handled it (may have been a no-op if event didn't exist — that's fine, idempotent)
        return { content: [{ type: "text" as const, text: "Memory deleted." }] }
      }

      // Daemon is down — fallback to direct disk delete
      const memKey = resolveMemoryKey(cwd)
      const deleted = deleteMemoryEvent(memKey, eventId)
      const text = deleted
        ? "Memory deleted (direct to disk — daemon not running)."
        : `Memory event not found: ${eventId}`
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "list_memory_events",
    "List all memory events for the current project/branch with their IDs. Use this to discover event IDs before calling update_memory or delete_memory.",
    {
      scope: z.enum(["project", "task", "both"]).optional().describe("Which events to list (default: both)"),
      type: z.enum(["decision", "error-resolution", "task-update", "file-context", "session-summary"]).optional().describe("Filter by event type"),
    },
    async ({ scope, type }) => {
      const memKey = resolveMemoryKey(cwd)
      const effectiveScope = scope ?? "both"
      const lines: string[] = []

      if (effectiveScope === "project" || effectiveScope === "both") {
        const project = loadProjectMemory(memKey.projectKey)
        if (project) {
          const events = type ? project.events.filter((e) => e.type === type) : project.events
          if (events.length > 0) {
            lines.push(`[Project: ${memKey.projectName}] (${events.length} events)`)
            for (const e of events) {
              const date = new Date(e.timestamp).toISOString().slice(0, 10)
              lines.push(`  id=${e.id}  [${e.type}] [${e.importance}] ${date}  ${e.content.slice(0, 120)}`)
            }
          }
        }
      }

      if (effectiveScope === "task" || effectiveScope === "both") {
        const task = loadTaskMemory(memKey.projectKey, memKey.taskKey)
        if (task) {
          const events = type ? task.events.filter((e) => e.type === type) : task.events
          if (events.length > 0) {
            if (lines.length > 0) lines.push("")
            lines.push(`[Task: ${memKey.branchName}] (${events.length} events)`)
            for (const e of events) {
              const date = new Date(e.timestamp).toISOString().slice(0, 10)
              lines.push(`  id=${e.id}  [${e.type}] [${e.importance}] ${date}  ${e.content.slice(0, 120)}`)
            }
          }
        }
      }

      const text = lines.length > 0 ? lines.join("\n") : "No memory events found."
      return { content: [{ type: "text" as const, text }] }
    },
  )

  return server
}

/**
 * Start the MCP server on stdio transport.
 * cwd is inferred from the process — Claude Code spawns MCP servers
 * in the project directory.
 */
export async function startMcpServer(): Promise<void> {
  const server = createAmbientMcpServer({ cwd: process.cwd() })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
