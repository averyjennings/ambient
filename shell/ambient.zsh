# ambient.zsh — Shell integration for the ambient agentic layer
#
# Add to your .zshrc:
#   source /path/to/ambient/shell/ambient.zsh
#
# This installs:
#   - preexec hook: tells the daemon what command is about to run
#   - precmd hook:  tells the daemon the exit code + current state
#   - chpwd hook:   tells the daemon when you change directories
#   - r() function: query any coding agent with ambient context
#   - Alt+A widget: inline AI suggestion in the command buffer

# --- Configuration ---
AMBIENT_BIN="${AMBIENT_BIN:-r}"

# --- Socket path (must match daemon) ---
_ambient_socket() {
  local runtime_dir="${XDG_RUNTIME_DIR:-$TMPDIR}"
  echo "${runtime_dir}/ambient-$(id -u).sock"
}

# --- Send a fire-and-forget message to the daemon ---
_ambient_notify() {
  local socket="$(_ambient_socket)"
  [[ -S "$socket" ]] || return 0

  # Non-blocking send via background subshell
  (echo "$1" | socat - "UNIX-CONNECT:${socket}" 2>/dev/null &)
}

# --- Git helpers (fast, cached per prompt) ---
_ambient_git_branch=""
_ambient_git_dirty=false

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

# --- Hooks ---

# preexec: runs after Enter, before the command executes
_ambient_preexec() {
  local cmd="$1"
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"preexec\",\"command\":$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"cwd\":\"$PWD\"}}"
}

# precmd: runs after the command finishes, before the next prompt
_ambient_precmd() {
  local exit_code=$?
  _ambient_refresh_git
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"precmd\",\"exitCode\":${exit_code},\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
}

# chpwd: runs when the directory changes
_ambient_chpwd() {
  _ambient_refresh_git
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
}

# --- Register hooks (compatible with oh-my-zsh and other frameworks) ---
autoload -Uz add-zsh-hook
add-zsh-hook preexec _ambient_preexec
add-zsh-hook precmd _ambient_precmd
add-zsh-hook chpwd _ambient_chpwd

# --- ZLE widget: Alt+A for inline AI suggestion ---
_ambient_ai_suggest() {
  local input="$BUFFER"
  [[ -z "$input" ]] && return

  # Replace buffer with "thinking..." indicator
  local original="$BUFFER"
  BUFFER="# (ambient: thinking...)"
  zle reset-prompt

  # Query the daemon synchronously (ZLE widgets block)
  local result
  result=$("$AMBIENT_BIN" "Convert to a shell command: $input" 2>/dev/null)

  if [[ -n "$result" ]]; then
    BUFFER="$result"
  else
    BUFFER="$original"
  fi
  CURSOR=${#BUFFER}
  zle reset-prompt
}

zle -N _ambient_ai_suggest
bindkey '\ea' _ambient_ai_suggest  # Alt+A

# --- Send initial context on shell startup ---
_ambient_refresh_git
_ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
