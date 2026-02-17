/**
 * Unified privacy gate.
 *
 * Combines the ignore list (directory-level opt-out) with the
 * secret filter (inline redaction) and config flags (local-only mode,
 * passive monitoring toggle).
 */

import { IgnoreList } from "./ignore.js"
import { sanitizeCommand, sanitizeText } from "./filter.js"

export interface PrivacyConfig {
  readonly localOnly: boolean
  readonly passiveMonitoring: boolean
  readonly ignoreFile: string
}

const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  localOnly: false,
  passiveMonitoring: true,
  ignoreFile: "",
}

export class PrivacyEngine {
  private readonly ignoreList: IgnoreList
  private readonly config: PrivacyConfig

  constructor(config?: Partial<PrivacyConfig>) {
    this.config = { ...DEFAULT_PRIVACY_CONFIG, ...config }
    this.ignoreList = new IgnoreList(this.config.ignoreFile || undefined)
  }

  /** Whether API calls are disabled (local-only mode). */
  isLocalOnly(): boolean {
    return this.config.localOnly
  }

  /** Whether passive tool-call monitoring is enabled. */
  isPassiveMonitoringEnabled(): boolean {
    return this.config.passiveMonitoring
  }

  /** Whether the given absolute path is in the ignore list. */
  isIgnored(cwd: string): boolean {
    return this.ignoreList.isIgnored(cwd)
  }

  /** Sanitize a shell command — redacts secrets, blocks sensitive commands. */
  sanitize(command: string): string {
    return sanitizeCommand(command)
  }

  /** Sanitize arbitrary text — redacts known token prefixes. */
  sanitizeText(text: string): string {
    return sanitizeText(text)
  }

  /** Whether an API call should be allowed (inverse of localOnly). */
  shouldAllowApiCall(): boolean {
    return !this.config.localOnly
  }

  /** Current ignore patterns for display. */
  getIgnorePatterns(): readonly string[] {
    return this.ignoreList.getPatterns()
  }
}
