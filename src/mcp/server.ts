import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { ContextEngine } from "../context/engine.js"

/**
 * Creates an MCP server that exposes ambient's context engine
 * as resources and tools. This allows MCP-compatible agents to
 * access shell context in a structured way instead of through
 * prompt-prefix injection.
 */
export function createAmbientMcpServer(contextEngine: ContextEngine): McpServer {
  const server = new McpServer({
    name: "ambient",
    version: "0.1.0",
  })

  // --- Resources ---

  server.resource(
    "shell-context",
    "ambient://context",
    async () => ({
      contents: [{
        uri: "ambient://context",
        mimeType: "application/json",
        text: JSON.stringify(contextEngine.getContext(), null, 2),
      }],
    }),
  )

  server.resource(
    "command-history",
    "ambient://history",
    async () => {
      const ctx = contextEngine.getContext()
      return {
        contents: [{
          uri: "ambient://history",
          mimeType: "application/json",
          text: JSON.stringify(ctx.recentCommands, null, 2),
        }],
      }
    },
  )

  server.resource(
    "project-info",
    "ambient://project",
    async () => {
      const ctx = contextEngine.getContext()
      return {
        contents: [{
          uri: "ambient://project",
          mimeType: "application/json",
          text: JSON.stringify({
            type: ctx.projectType,
            info: ctx.projectInfo,
            cwd: ctx.cwd,
          }, null, 2),
        }],
      }
    },
  )

  // --- Tools ---

  server.tool(
    "get_shell_context",
    "Get the current shell context including cwd, git state, last command, and project info",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: contextEngine.formatForPrompt(),
      }],
    }),
  )

  server.tool(
    "get_command_history",
    "Get recent command history with exit codes, optionally filtered to failures only",
    {
      failuresOnly: z.boolean().optional().describe("If true, only return commands that failed"),
      limit: z.number().optional().describe("Maximum number of commands to return (default: 20)"),
    },
    async ({ failuresOnly, limit }) => {
      const ctx = contextEngine.getContext()
      let commands = [...ctx.recentCommands]

      if (failuresOnly) {
        commands = commands.filter((c) => c.exitCode !== 0)
      }

      const maxResults = limit ?? 20
      commands = commands.slice(-maxResults)

      return {
        content: [{
          type: "text" as const,
          text: commands.map((c) =>
            `[${new Date(c.timestamp).toISOString()}] ${c.command} → exit ${c.exitCode} (in ${c.cwd})`,
          ).join("\n") || "No commands recorded",
        }],
      }
    },
  )

  server.tool(
    "get_project_info",
    "Get detected project type, available scripts/commands, package manager, and framework",
    {},
    async () => {
      const ctx = contextEngine.getContext()
      if (!ctx.projectInfo) {
        return {
          content: [{
            type: "text" as const,
            text: "No project detected in current directory",
          }],
        }
      }

      const info = ctx.projectInfo
      const lines = [`Project type: ${info.type}`]
      if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`)
      if (info.framework) lines.push(`Framework: ${info.framework}`)
      if (info.scripts.length > 0) lines.push(`Available scripts: ${info.scripts.join(", ")}`)

      return {
        content: [{
          type: "text" as const,
          text: lines.join("\n"),
        }],
      }
    },
  )

  return server
}

/**
 * Start the MCP server on stdio transport.
 * This is used when an MCP-compatible agent needs to connect.
 */
export async function startMcpServer(contextEngine: ContextEngine): Promise<void> {
  const server = createAmbientMcpServer(contextEngine)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
