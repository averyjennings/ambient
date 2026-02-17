/**
 * Redact sensitive data from command text and arbitrary strings.
 *
 * Two levels of filtering:
 *   1. Entire-command blocking — commands that read secret files
 *   2. Inline redaction — strips secret values while keeping key names
 */

/** Patterns that match inline secrets (key=value, token prefixes, etc.) */
function secretPatterns(): RegExp[] {
  return [
    // Inline assignment patterns
    /(?:password|passwd|token|secret|api[_-]?key|credentials?)\s*[=:]\s*\S+/gi,
    // Known environment variable exports
    /(?:export\s+)?(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|DATABASE_URL|REDIS_URL|MONGO_URI)\s*=\s*\S+/gi,
    // Known token prefixes (Anthropic, GitHub, Slack, etc.)
    /\b(?:sk-ant-api\w{2}-[\w-]+|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,}|xoxb-[\w-]+|xoxp-[\w-]+)\b/g,
    // Docker/mysql password flags
    /(?:--password|-p)\s+\S+/gi,
  ]
}

/** Patterns that cause the entire command to be blocked. */
function blockedCommandPatterns(): RegExp[] {
  return [
    /cat\s+.*(?:\.ssh\/|\.gnupg\/|credentials|\.pem|\.key)/i,
    /printenv\s*\|\s*grep\s+(?:key|token|secret|password)/i,
  ]
}

/**
 * Sanitize a shell command. Blocked commands are fully redacted;
 * otherwise inline secrets are replaced with [REDACTED].
 */
export function sanitizeCommand(command: string): string {
  for (const pattern of blockedCommandPatterns()) {
    if (pattern.test(command)) return "[sensitive command redacted]"
  }

  let sanitized = command
  for (const pattern of secretPatterns()) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Keep the key name, redact the value
      const eqIndex = match.search(/[=:]\s*/)
      if (eqIndex >= 0) {
        const separator = match.slice(eqIndex, eqIndex + 1)
        return match.slice(0, eqIndex) + separator + "[REDACTED]"
      }
      return "[REDACTED]"
    })
  }
  return sanitized
}

/**
 * Sanitize arbitrary text — applies only token-prefix patterns
 * (not key=value patterns, which would false-positive on prose).
 */
export function sanitizeText(text: string): string {
  // Only apply the token prefix pattern (index 2 from secretPatterns)
  const tokenPattern = /\b(?:sk-ant-api\w{2}-[\w-]+|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,}|xoxb-[\w-]+|xoxp-[\w-]+)\b/g
  return text.replace(tokenPattern, "[REDACTED]")
}

/**
 * Check if text contains any sensitive data patterns.
 */
export function containsSensitiveData(text: string): boolean {
  for (const pattern of secretPatterns()) {
    if (pattern.test(text)) return true
  }
  return false
}
