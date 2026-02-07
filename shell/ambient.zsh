# ambient.zsh — Shell integration for the ambient agentic layer
#
# Add to your .zshrc:
#   source /path/to/ambient/shell/ambient.zsh
#
# This installs:
#   - preexec hook: tells the daemon what command is about to run
#   - precmd hook:  tells the daemon the exit code + current state
#   - chpwd hook:   tells the daemon when you change directories
#   - Alt+A widget: inline AI suggestion in the command buffer
#
# No external dependencies — uses `r notify` for daemon communication.

# --- Resolve the ambient binary ---
# Use the built binary from the project, or fall back to PATH
if [[ -z "$AMBIENT_BIN" ]]; then
  if [[ -x "${0:A:h}/../dist/cli/index.js" ]]; then
    AMBIENT_BIN="node ${0:A:h}/../dist/cli/index.js"
  else
    AMBIENT_BIN="r"
  fi
fi

# --- Send a fire-and-forget message to the daemon ---
_ambient_notify() {
  # Use `r notify` — no socat dependency needed
  # Run in background subshell so it never blocks the prompt
  # ${=AMBIENT_BIN} splits "node /path/to/file" into words without re-expanding args
  (${=AMBIENT_BIN} notify "$1" &>/dev/null &)
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

# --- Hooks ---

# preexec: runs after Enter, before the command executes
_ambient_preexec() {
  local cmd="$(_ambient_json_escape "$1")"
  _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"preexec\",\"command\":\"${cmd}\",\"cwd\":\"$PWD\"}}"
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
  result=$(${=AMBIENT_BIN} "Convert to a shell command: $input" 2>/dev/null)

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

# --- Override zsh's built-in `r` with ambient ---
# zsh has a built-in `r` (alias for `fc -e -`). We override it with a function
# so `r "query"` invokes ambient instead. Functions take precedence over builtins.
# If you need the original `r` (re-run last command), use `fc -e -` directly.
disable -a r 2>/dev/null  # disable the built-in alias
r() {
  # ${=AMBIENT_BIN} splits the var into words (e.g. "node /path/to/cli")
  # "$@" preserves user argument quoting (no re-expansion of globs like ? *)
  ${=AMBIENT_BIN} "$@"
}

# --- Send initial context on shell startup ---
_ambient_refresh_git
_ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
