/**
 * Core types for ambient — the agentic shell layer.
 */

// --- Agent definitions ---

export interface AgentConfig {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly streamFormat: "text" | "json-lines" | "stream-json"
  readonly contextInjection: "prompt-prefix" | "stdin" | "mcp"
  readonly description?: string
  /** Args to append for continuing the last session (e.g. ["--continue"]) */
  readonly continueArgs?: readonly string[]
}

// --- Context ---

export interface ProjectInfo {
  readonly type: string
  readonly packageManager?: string
  readonly scripts: readonly string[]
  readonly framework?: string
}

export interface ShellContext {
  readonly cwd: string
  readonly gitBranch: string | null
  readonly gitDirty: boolean
  readonly lastCommand: string | null
  readonly lastExitCode: number | null
  readonly recentCommands: readonly CommandRecord[]
  readonly projectType: string | null
  readonly projectInfo: ProjectInfo | null
  readonly env: Readonly<Record<string, string>>
}

export interface CommandRecord {
  readonly command: string
  readonly exitCode: number
  readonly cwd: string
  readonly timestamp: number
}

// --- Session state ---

export interface SessionState {
  /** Which agent the current session is with */
  agentName: string
  /** Number of queries in this session */
  queryCount: number
  /** Cached text from the last agent response */
  lastResponse: string
  /** When the session started */
  startedAt: number
}

// --- IPC protocol (daemon <-> CLI) ---

export interface NewSessionPayload {
  readonly cwd?: string
}

export interface DaemonRequest {
  readonly type: "query" | "context-update" | "ping" | "shutdown" | "status" | "new-session" | "agents"
  readonly payload: QueryPayload | ContextUpdatePayload | NewSessionPayload | Record<string, never>
}

export interface QueryPayload {
  readonly prompt: string
  readonly agent?: string
  readonly pipeInput?: string
  readonly cwd: string
  readonly newSession?: boolean
}

export interface ContextUpdatePayload {
  readonly event: "preexec" | "precmd" | "chpwd"
  readonly command?: string
  readonly exitCode?: number
  readonly cwd: string
  readonly gitBranch?: string
  readonly gitDirty?: boolean
}

export interface DaemonResponse {
  readonly type: "chunk" | "done" | "error" | "status"
  readonly data: string
}

// --- Configuration ---

export interface AmbientConfig {
  readonly defaultAgent: string
  readonly agents: Readonly<Record<string, AgentConfig>>
  readonly maxRecentCommands: number
  readonly socketPath: string
  readonly logLevel: "debug" | "info" | "warn" | "error"
}
