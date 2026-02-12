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

# --- Auto-assist state ---
_ambient_last_command=""
_ambient_handled_by_cnf=0  # flag: command_not_found_handler already responded

# --- command_not_found_handler ---
# Intercepts "command not found" BEFORE zsh prints its error.
# Captures output first to avoid printing an empty "ambient →" prefix
# when rate-limited or when the daemon is unreachable.
command_not_found_handler() {
  _ambient_handled_by_cnf=1
  local response
  response=$(perl -e 'alarm 4; exec @ARGV' ${=AMBIENT_BIN} assist "$*" 127 2>/dev/null)
  if [[ -n "$response" ]]; then
    printf '\033[2m\033[33m  ambient → %s\033[0m\n' "$response"
  else
    # No response (rate-limited or daemon down) — show zsh's default error
    printf 'zsh: command not found: %s\n' "$1" >&2
  fi
  return 127
}

# --- Hooks ---

# preexec: runs after Enter, before the command executes
_ambient_preexec() {
  _ambient_last_command="$1"
  _ambient_handled_by_cnf=0

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

# --- ZLE widget: intercept natural language before zsh tries to execute ---
# Catches: apostrophes (what's), question marks (what?), and conversation starters.
# This runs BEFORE zsh parses the input, preventing glob errors on ? and
# quote-wait on unmatched apostrophes.
_ambient_accept_line() {
  local buf="$BUFFER"
  [[ -z "$buf" ]] && { zle .accept-line; return }

  local first_word="${buf%% *}"
  local is_natural=0

  # 1. Unmatched apostrophes that look like contractions (what's, don't, I'm)
  local singles="${buf//[^\']/}"
  if (( ${#singles} % 2 != 0 )); then
    if [[ "$buf" =~ [a-zA-Z]\'[a-zA-Z] ]]; then
      is_natural=1
    fi
  fi

  # 2. Contains ? in a multi-word context — almost always natural language
  if (( is_natural == 0 )) && [[ "$buf" == *"?"* ]]; then
    local word_count=${#${=buf}}
    if (( word_count >= 2 )); then
      is_natural=1
    fi
  fi

  # 3. Starts with a conversational word (2+ words only)
  if (( is_natural == 0 )) && [[ "$buf" == *" "* ]]; then
    local lower_first="${first_word:l}"
    case "$lower_first" in
      what|how|why|where|when|who|can|could|would|should|does|did|is|are|was|were|tell|show|explain|help|hey|hi|hello|thanks|thank|please|yo|sup)
        is_natural=1
        ;;
    esac
  fi

  # If it looks like natural language, route to ambient
  if (( is_natural == 1 )); then
    print
    printf '\033[2m\033[33m  ambient → '
    ${=AMBIENT_BIN} assist "$buf" 127 2>/dev/null
    printf '\033[0m\n'
    BUFFER=""
    zle reset-prompt
    return
  fi

  # Not NL — let zsh handle it normally
  zle .accept-line
}
zle -N accept-line _ambient_accept_line

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

# --- Capture wrapper: runs a command and stores output for context ---
# Usage: rc pnpm build
# The output is captured and sent to the daemon, so the next `r "fix this"`
# query will include the error output automatically.
rc() {
  local capture_file
  capture_file=$(mktemp /tmp/ambient-capture.XXXXXX)
  "$@" 2>&1 | tee "$capture_file"
  local exit_code=${pipestatus[1]}
  # Always capture output (not just on failure) so ambient can answer questions about it
  ${=AMBIENT_BIN} capture < "$capture_file" &>/dev/null &
  rm -f "$capture_file"
  return $exit_code
}

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

# --- Reload: build + restart daemon + re-source shell in one shot ---
_AMBIENT_ROOT="${0:A:h}/.."
_AMBIENT_SHELL="${0:A}"

reload() {
  echo "Building..."
  (cd "$_AMBIENT_ROOT" && pnpm build) || { echo "Build failed."; return 1; }
  ${=AMBIENT_BIN} daemon stop 2>/dev/null
  echo "Re-sourcing shell integration..."
  source "$_AMBIENT_SHELL"
  ${=AMBIENT_BIN} daemon start 2>/dev/null
  echo "Done."
}

# --- Send initial context on shell startup ---
_ambient_refresh_git
_ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"${_ambient_git_branch}\",\"gitDirty\":${_ambient_git_dirty}}}"
