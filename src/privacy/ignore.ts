/**
 * Gitignore-style directory matching against ~/.ambient/ignore.
 *
 * Patterns:
 *   - Lines starting with # are comments
 *   - Blank lines are skipped
 *   - ~ at start is expanded to homedir
 *   - ** at end matches all descendants
 *   - Exact path (no glob) checks startsWith
 *   - Basename patterns (e.g. *.env) match against the file/dir name
 */

import { readFileSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

const RELOAD_DEBOUNCE_MS = 5000

export class IgnoreList {
  private patterns: string[] = []
  private lastModified: number = 0
  private lastChecked: number = 0
  private readonly filePath: string
  private readonly home: string

  constructor(filePath?: string) {
    this.home = homedir()
    this.filePath = filePath ?? join(this.home, ".ambient", "ignore")
    this.reload()
  }

  reload(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, "utf-8")
    } catch {
      // File doesn't exist or not readable — empty patterns, no crash
      this.patterns = []
      this.lastModified = 0
      return
    }

    try {
      const stat = statSync(this.filePath)
      this.lastModified = stat.mtimeMs
    } catch {
      this.lastModified = 0
    }

    this.patterns = raw
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"))
  }

  /**
   * Check if a file was modified since we last loaded it.
   * Debounced to avoid stat() on every call.
   */
  private maybeReload(): void {
    const now = Date.now()
    if (now - this.lastChecked < RELOAD_DEBOUNCE_MS) return
    this.lastChecked = now

    try {
      const stat = statSync(this.filePath)
      if (stat.mtimeMs !== this.lastModified) {
        this.reload()
      }
    } catch {
      // File gone — clear patterns
      if (this.patterns.length > 0) {
        this.patterns = []
        this.lastModified = 0
      }
    }
  }

  isIgnored(absolutePath: string): boolean {
    this.maybeReload()

    for (const raw of this.patterns) {
      const pattern = this.expandHome(raw)

      // Glob-suffix: /path/to/dir/** matches any descendant
      if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -3)
        if (absolutePath === prefix || absolutePath.startsWith(prefix + "/")) {
          return true
        }
        continue
      }

      // Basename pattern (no path separator): e.g. *.env, .secrets
      if (!pattern.includes("/")) {
        const name = basename(absolutePath)
        if (this.matchBasename(pattern, name)) {
          return true
        }
        continue
      }

      // Exact prefix match — pattern is a directory
      if (absolutePath === pattern || absolutePath.startsWith(pattern + "/")) {
        return true
      }
    }

    return false
  }

  getPatterns(): readonly string[] {
    return this.patterns
  }

  /**
   * Simple basename matching. Supports leading * as a wildcard prefix.
   * e.g. "*.env" matches ".env" and "prod.env", ".secrets" matches exactly.
   */
  private matchBasename(pattern: string, name: string): boolean {
    if (pattern.startsWith("*")) {
      return name.endsWith(pattern.slice(1))
    }
    return name === pattern
  }

  private expandHome(pattern: string): string {
    if (pattern.startsWith("~/")) {
      return this.home + pattern.slice(1)
    }
    if (pattern === "~") {
      return this.home
    }
    return pattern
  }
}
