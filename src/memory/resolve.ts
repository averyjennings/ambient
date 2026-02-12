import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import type { MemoryKey } from "../types/index.js"

// --- Caches ---

const gitRootCache = new Map<string, string | null>()
const gitRemoteCache = new Map<string, string | null>()
const gitBranchCache = new Map<string, { branch: string; timestamp: number }>()

const BRANCH_CACHE_TTL_MS = 5_000

// --- Public API ---

/**
 * Resolve a working directory into a two-level memory key.
 *
 * The project key is derived from the git remote URL (so clones in
 * different paths share memory), falling back to the git root path,
 * then cwd for non-git directories.
 *
 * The task key is derived from the current git branch name (sanitized
 * for filesystem safety), defaulting to "default" for non-git dirs.
 */
export function resolveMemoryKey(cwd: string): MemoryKey {
  const gitRoot = resolveGitRoot(cwd)
  const remote = gitRoot ? resolveGitRemote(gitRoot) : null
  const branch = gitRoot ? resolveGitBranch(gitRoot) : "default"

  const originSource = remote ?? gitRoot ?? cwd
  const projectKey = hashString(originSource)
  const projectName = remote
    ? extractRepoName(remote)
    : basename(gitRoot ?? cwd)
  const taskKey = sanitizeBranchName(branch)

  return {
    projectKey,
    taskKey,
    projectName,
    branchName: branch,
    origin: originSource,
  }
}

/**
 * Resolve the git root for a directory. Returns null if not in a git repo.
 * Exported separately for use by the context file generator.
 */
export function resolveGitRoot(cwd: string): string | null {
  if (gitRootCache.has(cwd)) {
    return gitRootCache.get(cwd) ?? null
  }

  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    gitRootCache.set(cwd, root)
    return root
  } catch {
    gitRootCache.set(cwd, null)
    return null
  }
}

/**
 * Sanitize a branch name for safe use as a filename.
 * Replaces `/` with `--`, strips unsafe chars, truncates to 100 chars.
 */
export function sanitizeBranchName(branch: string): string {
  if (!branch) return "default"

  const sanitized = branch
    .replace(/\//g, "--")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 100)

  return sanitized || "default"
}

// --- Internal helpers ---

function resolveGitRemote(gitRoot: string): string | null {
  if (gitRemoteCache.has(gitRoot)) {
    return gitRemoteCache.get(gitRoot) ?? null
  }

  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    gitRemoteCache.set(gitRoot, url || null)
    return url || null
  } catch {
    gitRemoteCache.set(gitRoot, null)
    return null
  }
}

function resolveGitBranch(gitRoot: string): string {
  const cached = gitBranchCache.get(gitRoot)
  if (cached && Date.now() - cached.timestamp < BRANCH_CACHE_TTL_MS) {
    return cached.branch
  }

  try {
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    gitBranchCache.set(gitRoot, { branch: branch || "detached", timestamp: Date.now() })
    return branch || "detached"
  } catch {
    // Detached HEAD or other edge case
    gitBranchCache.set(gitRoot, { branch: "detached", timestamp: Date.now() })
    return "detached"
  }
}

/**
 * Extract a human-readable repo name from a git remote URL.
 * Handles both SSH (git@github.com:user/repo.git) and HTTPS formats.
 */
function extractRepoName(remoteUrl: string): string {
  // SSH: git@github.com:user/repo.git -> repo
  const sshMatch = remoteUrl.match(/[/:]([\w.-]+?)(?:\.git)?$/)
  if (sshMatch?.[1]) return sshMatch[1]

  // HTTPS: https://github.com/user/repo -> repo
  const httpsMatch = remoteUrl.match(/\/([\w.-]+?)(?:\.git)?$/)
  if (httpsMatch?.[1]) return httpsMatch[1]

  return basename(remoteUrl)
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}
