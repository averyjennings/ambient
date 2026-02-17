#!/usr/bin/env bash
# ambient.bash — Ambient shell integration for bash 4+
#
# Add to your .bashrc:
#   [ -f /path/to/ambient/shell/ambient.bash ] && source /path/to/ambient/shell/ambient.bash
#
# This installs:
#   - preexec hook (via DEBUG trap): tells the daemon what command is about to run
#   - precmd hook (via PROMPT_COMMAND): tells the daemon the exit code + current state
#   - chpwd detection: tells the daemon when you change directories
#   - Alt+A keybinding: inline AI suggestion in the command buffer
#
# Limitations vs zsh:
#   - No Enter key NL interception — bash has no ZLE equivalent.
#     Natural language queries are handled via command_not_found_handle only.
#   - No auto-capture wrapping — DEBUG trap cannot modify commands before execution.
#     Users must use `rc <cmd>` explicitly for output capture.
#
# Requires bash 4.0+ for ${var,,} lowercase and associative arrays.
#
# ── SAFETY: Same rules as ambient.zsh ────────────────────────────────
# 1. NEVER use `exec` to replace the shell process
# 2. NEVER spawn Node.js synchronously during shell init
# 3. NEVER wrap the shell in a pseudo-TTY layer
# ─────────────────────────────────────────────────────────────────────

# Bail out if bash version is too old
if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
  echo "ambient: bash 4+ required (found ${BASH_VERSION})" >&2
  return 2>/dev/null || exit 1
fi

# --- Path resolution ---
AMBIENT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Resolve the ambient binary ---
if [[ -z "$AMBIENT_BIN" ]]; then
  if [[ -x "${AMBIENT_SCRIPT_DIR}/../dist/cli/index.js" ]]; then
    AMBIENT_BIN="node ${AMBIENT_SCRIPT_DIR}/../dist/cli/index.js"
  else
    AMBIENT_BIN="r"
  fi
fi

# --- Configuration ---
_ambient_last_command=""
_ambient_handled_by_cnf=0
_ambient_last_cwd="$PWD"
_ambient_in_preexec=0
_ambient_git_branch=""
_ambient_git_dirty=false

# --- IPC helpers ---

# Send a fire-and-forget message to the daemon.
# Runs in background subshell so it never blocks the prompt.
_ambient_notify() {
  ($AMBIENT_BIN notify "$1" &>/dev/null &)
}

# --- JSON escaping for command strings ---
_ambient_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"    # backslash
  s="${s//\"/\\\"}"    # double quote
  s="${s//$'\n'/\\n}"  # newline
  s="${s//$'\r'/\\r}"  # carriage return
  s="${s//$'\t'/\\t}"  # tab
  printf '%s' "$s"
}

# --- Git helpers (fast, cached per prompt) ---
_ambient_refresh_git() {
  if git rev-parse --is-inside-work-tree &>/dev/null; then
    _ambient_git_branch="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)"
    if [[ -n "$(git status --porcelain 2>/dev/null | head -1)" ]]; then
      _ambient_git_dirty=true
    else
      _ambient_git_dirty=false
    fi
  else
    _ambient_git_branch=""
    _ambient_git_dirty=false
  fi
}

# --- Shell hooks ---

# preexec: runs after Enter, before the command executes.
# Implemented via DEBUG trap. Guard prevents re-entry for compound commands.
_ambient_preexec() {
  # Guard: only fire once per command line (not for each pipeline segment)
  if [[ "$_ambient_in_preexec" -eq 1 ]]; then
    return
  fi
  _ambient_in_preexec=1

  local cmd="$1"
  _ambient_last_command="$cmd"
  _ambient_handled_by_cnf=0

  local escaped
  escaped="$(_ambient_json_escape "$cmd")"
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"preexec\",\"command\":\"${escaped}\",\"cwd\":\"$PWD\"}}"
}

# precmd: runs after the command finishes, before the next prompt.
# Appended to PROMPT_COMMAND.
_ambient_precmd() {
  local exit_code=$?

  # Reset the preexec guard for the next command
  _ambient_in_preexec=0

  # chpwd detection: compare current directory to last known
  if [[ "$PWD" != "$_ambient_last_cwd" ]]; then
    _ambient_last_cwd="$PWD"
    _ambient_chpwd
  fi

  _ambient_refresh_git
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"precmd\",\"exitCode\":${exit_code},\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
}

# chpwd: runs when the directory changes (detected in precmd).
_ambient_chpwd() {
  _ambient_refresh_git
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
}

# --- Register hooks ---

# DEBUG trap for preexec
trap '_ambient_preexec "$BASH_COMMAND"' DEBUG

# Append precmd to PROMPT_COMMAND (preserve existing entries)
if [[ -z "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="_ambient_precmd"
elif [[ "$PROMPT_COMMAND" != *"_ambient_precmd"* ]]; then
  PROMPT_COMMAND="${PROMPT_COMMAND%;};_ambient_precmd"
fi

# --- Output capture (rc wrapper) ---
# Usage: rc pnpm build
# Captures output and sends to the daemon for context.
rc() {
  local capture_file
  capture_file=$(mktemp /tmp/ambient-capture.XXXXXX)
  "$@" 2>&1 | tee "$capture_file"
  local exit_code=${PIPESTATUS[0]}
  ($AMBIENT_BIN capture < "$capture_file" &>/dev/null &)
  rm -f "$capture_file"
  return $exit_code
}

# --- Auto-capture whitelist ---
# Commands known to be non-interactive and whose output is valuable context.
# In bash, auto-capture wrapping is NOT automatic (no ZLE to modify buffer).
# This list is used only by the `rc` wrapper for documentation and future use.
_ambient_autocapture_whitelist=(
  # Node.js / JS ecosystem
  pnpm npm yarn npx bun deno tsc tsx eslint prettier vitest jest mocha
  # Python
  pip pip3 pytest mypy ruff black flake8 pylint uv
  # Rust
  cargo rustc clippy
  # Go
  go golangci-lint
  # General build tools
  make cmake ninja gradle mvn ant
  # Infrastructure / ops
  terraform pulumi helm
  # Linters / formatters
  shellcheck shfmt yamllint jsonlint
  # Compilers
  gcc g++ clang javac swift swiftc
)

# --- AI suggestion widget (Alt+A) ---
# Uses readline's bind -x to invoke a function that replaces the current line.
_ambient_ai_suggest() {
  local input="$READLINE_LINE"
  [[ -z "$input" ]] && return

  # Show thinking indicator
  local original="$READLINE_LINE"
  READLINE_LINE="# (ambient: thinking...)"
  READLINE_POINT=${#READLINE_LINE}

  # Query the daemon synchronously (4s timeout prevents shell freeze)
  local result
  result=$(timeout 4 $AMBIENT_BIN "Convert to a shell command: $input" 2>/dev/null)

  if [[ -n "$result" ]]; then
    READLINE_LINE="$result"
  else
    READLINE_LINE="$original"
  fi
  READLINE_POINT=${#READLINE_LINE}
}

# Bind Alt+A (only in interactive shells)
if [[ $- == *i* ]]; then
  bind -x '"\ea":"_ambient_ai_suggest"'
fi

# --- command_not_found ---
# Intercepts "command not found" before bash prints its error.
command_not_found_handle() {
  _ambient_handled_by_cnf=1
  local response
  response=$(timeout 4 $AMBIENT_BIN assist "$*" 127 2>/dev/null)
  if [[ -n "$response" ]]; then
    printf '\033[2m\033[33m  ambient \xe2\x86\x92 %s\033[0m\n' "$response"
  else
    printf 'bash: %s: command not found\n' "$1" >&2
  fi
  return 127
}

# --- r command ---
# Override bash's built-in `r` (alias for `fc -s`).
unalias r 2>/dev/null
r() {
  $AMBIENT_BIN "$@"
}

# --- Reload: build + restart daemon + re-source shell in one shot ---
_AMBIENT_ROOT="${AMBIENT_SCRIPT_DIR}/.."
_AMBIENT_SHELL="${BASH_SOURCE[0]}"

reload() {
  echo "Building..."
  (cd "$_AMBIENT_ROOT" && pnpm build) || { echo "Build failed."; return 1; }
  $AMBIENT_BIN daemon stop 2>/dev/null
  echo "Re-sourcing shell integration..."
  source "$_AMBIENT_SHELL"
  $AMBIENT_BIN daemon start 2>/dev/null
  echo "Done."
}

# --- Send initial context on shell startup ---
_ambient_refresh_git
_ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
