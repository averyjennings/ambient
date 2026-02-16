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
  /** Capability tags for auto-selection */
  readonly capabilities?: readonly string[]
  /** Priority when multiple agents match (higher = preferred) */
  readonly priority?: number
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

export interface CapturePayload {
  readonly output: string
  readonly cwd: string
}

export interface ComparePayload {
  readonly prompt: string
  readonly agents: readonly string[]
  readonly pipeInput?: string
  readonly cwd: string
}

export interface AssistPayload {
  /** The command that failed */
  readonly command: string
  /** The exit code */
  readonly exitCode: number
  /** Current working directory */
  readonly cwd: string
  /** Captured stderr (optional, may be empty) */
  readonly stderr?: string
  /** Captured command output (stdout+stderr from the command that just ran) */
  readonly output?: string
}

export interface DaemonRequest {
  readonly type: "query" | "context-update" | "ping" | "shutdown" | "status" | "new-session" | "agents" | "capture" | "suggest" | "compare" | "assist" | "memory-store" | "memory-read" | "memory-delete" | "memory-update" | "memory-search" | "output-read" | "context-read" | "activity" | "activity-flush"
  readonly payload: QueryPayload | ContextUpdatePayload | NewSessionPayload | CapturePayload | ComparePayload | AssistPayload | MemoryStorePayload | MemoryReadPayload | MemoryDeletePayload | MemoryUpdatePayload | MemorySearchPayload | ContextReadPayload | ActivityPayload | ActivityFlushPayload | Record<string, never>
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

// --- Templates ---

export interface TemplateConfig {
  /** Shell command to run and pipe as context */
  readonly command?: string
  /** Prompt to send to the agent */
  readonly prompt: string
  /** Description shown in `r templates` */
  readonly description?: string
}

// --- Configuration ---

export interface AmbientConfig {
  readonly defaultAgent: string
  readonly agents: Readonly<Record<string, AgentConfig>>
  readonly templates: Readonly<Record<string, TemplateConfig>>
  readonly maxRecentCommands: number
  readonly socketPath: string
  readonly logLevel: "debug" | "info" | "warn" | "error"
}

// --- Two-level memory system ---

export type MemoryEventType =
  | "decision"
  | "error-resolution"
  | "task-update"
  | "file-context"
  | "session-summary"

export type MemoryImportance = "low" | "medium" | "high"

export interface MemoryEvent {
  readonly id: string
  readonly type: MemoryEventType
  readonly timestamp: number
  readonly content: string
  readonly importance: MemoryImportance
  readonly metadata?: Readonly<Record<string, string>>
}

/** Project-level memory — shared across all branches */
export interface ProjectMemory {
  readonly projectKey: string
  readonly projectName: string
  readonly origin: string
  readonly createdAt: number
  lastActive: number
  events: MemoryEvent[]
}

/** Task-level memory — scoped to a single branch */
export interface TaskMemory {
  readonly branchKey: string
  readonly branchName: string
  readonly projectKey: string
  readonly createdAt: number
  lastActive: number
  archived: boolean
  events: MemoryEvent[]
}

/** Resolved key for the two-level memory hierarchy */
export interface MemoryKey {
  readonly projectKey: string
  readonly taskKey: string
  readonly projectName: string
  readonly branchName: string
  readonly origin: string
}

// --- Memory IPC payloads ---

export interface MemoryStorePayload {
  readonly cwd: string
  readonly eventType: MemoryEventType
  readonly content: string
  readonly importance?: MemoryImportance
  readonly metadata?: Record<string, string>
}

export interface MemoryReadPayload {
  readonly cwd: string
  readonly scope?: "project" | "task" | "both"
}

export interface MemoryDeletePayload {
  readonly cwd: string
  readonly eventId: string
}

export interface MemoryUpdatePayload {
  readonly cwd: string
  readonly eventId: string
  readonly newContent: string
}

export interface MemorySearchPayload {
  readonly query: string
  readonly cwd?: string
  readonly maxEvents?: number
}

export interface ContextReadPayload {
  readonly cwd?: string
}

// --- Passive activity monitoring payloads ---

export interface ActivityPayload {
  readonly cwd: string
  readonly tool: string
  readonly filePath?: string
  readonly command?: string
  readonly description?: string
}

export interface ActivityFlushPayload {
  readonly cwd: string
  readonly reasoning?: string
}
