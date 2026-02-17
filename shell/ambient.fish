# ambient.fish — Ambient shell integration for fish 3.1+
#
# Add to your config.fish:
#   if test -f /path/to/ambient/shell/ambient.fish
#       source /path/to/ambient/shell/ambient.fish
#   end
#
# This installs:
#   - fish_preexec hook: tells the daemon what command is about to run
#   - fish_postexec hook: tells the daemon the exit code + current state
#   - PWD variable watcher: tells the daemon when you change directories
#   - Enter key binding: intercepts natural language before fish parses it
#   - Alt+A keybinding: inline AI suggestion in the command buffer
#
# Requires fish 3.1+ for $pipestatus support.
#
# ── SAFETY: Same rules as ambient.zsh ────────────────────────────────
# 1. NEVER use `exec` to replace the shell process
# 2. NEVER spawn Node.js synchronously during shell init
# 3. NEVER wrap the shell in a pseudo-TTY layer
# ─────────────────────────────────────────────────────────────────────

# --- Path resolution ---
set -g _ambient_script_dir (status dirname 2>/dev/null; or begin; set -l src (status filename); string replace -r '/[^/]*$' '' $src; end)

# --- Resolve the ambient binary ---
if not set -q AMBIENT_BIN; or test -z "$AMBIENT_BIN"
    if test -x "$_ambient_script_dir/../dist/cli/index.js"
        set -gx AMBIENT_BIN "node" "$_ambient_script_dir/../dist/cli/index.js"
    else
        set -gx AMBIENT_BIN "r"
    end
end

# --- Configuration ---
set -g _ambient_last_command ""
set -g _ambient_handled_by_cnf 0
set -g _ambient_git_branch ""
set -g _ambient_git_dirty false

# --- IPC helpers ---

# Send a fire-and-forget message to the daemon.
function _ambient_notify
    fish -c "$AMBIENT_BIN notify $argv[1]" &>/dev/null &
    disown 2>/dev/null
end

# --- JSON escaping for command strings ---
function _ambient_json_escape
    set -l s $argv[1]
    set s (string replace -a '\\' '\\\\' $s)
    set s (string replace -a '"' '\\"' $s)
    set s (string replace -a \n '\\n' $s)
    set s (string replace -a \r '\\r' $s)
    set s (string replace -a \t '\\t' $s)
    printf '%s' $s
end

# --- Git helpers (fast, cached per prompt) ---
function _ambient_refresh_git
    if git rev-parse --is-inside-work-tree &>/dev/null
        set -g _ambient_git_branch (git symbolic-ref --short HEAD 2>/dev/null; or git rev-parse --short HEAD 2>/dev/null)
        if test -n (git status --porcelain 2>/dev/null | head -1)
            set -g _ambient_git_dirty true
        else
            set -g _ambient_git_dirty false
        end
    else
        set -g _ambient_git_branch ""
        set -g _ambient_git_dirty false
    end
end

# --- Shell hooks ---

# preexec: runs after Enter, before the command executes
function _ambient_preexec --on-event fish_preexec
    set -g _ambient_last_command $argv[1]
    set -g _ambient_handled_by_cnf 0

    set -l cmd (_ambient_json_escape "$argv[1]")
    _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"preexec\",\"command\":\"$cmd\",\"cwd\":\"$PWD\"}}"
end

# postcmd: runs after the command finishes, before the next prompt
function _ambient_postcmd --on-event fish_postexec
    set -l exit_code $status

    _ambient_refresh_git
    _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"precmd\",\"exitCode\":$exit_code,\"cwd\":\"$PWD\",\"gitBranch\":\"$_ambient_git_branch\",\"gitDirty\":$_ambient_git_dirty}}"
end

# chpwd: runs when the directory changes
function _ambient_chpwd --on-variable PWD
    _ambient_refresh_git
    _ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"$_ambient_git_branch\",\"gitDirty\":$_ambient_git_dirty}}"
end

# --- Auto-capture whitelist ---
# Commands known to be non-interactive and whose output is valuable context.
set -g _ambient_autocapture_whitelist \
    # Node.js / JS ecosystem
    pnpm npm yarn npx bun deno tsc tsx eslint prettier vitest jest mocha \
    # Python
    pip pip3 pytest mypy ruff black flake8 pylint uv \
    # Rust
    cargo rustc clippy \
    # Go
    go golangci-lint \
    # General build tools
    make cmake ninja gradle mvn ant \
    # Infrastructure / ops
    terraform pulumi helm \
    # Linters / formatters
    shellcheck shfmt yamllint jsonlint \
    # Compilers
    gcc g++ clang javac swift swiftc

function _ambient_should_autocapture
    set -l cmd $argv[1]
    set -l first_word (string split ' ' $cmd)[1]

    # Resolve aliases to underlying command
    set -l resolved (command -v $first_word 2>/dev/null)
    if string match -q '/*' $resolved
        set first_word (string replace -r '.+/' '' $resolved)
    end

    for w in $_ambient_autocapture_whitelist
        if test "$first_word" = "$w"
            return 0
        end
    end
    return 1
end

# --- Natural language interception on Enter ---
# Fish's commandline builtin gives full buffer access, so NL detection is possible.
function _ambient_accept_line
    set -l buf (commandline)
    if test -z "$buf"
        commandline -f execute
        return
    end

    set -l first_word (string split ' ' $buf)[1]
    set -l is_natural 0

    # If the first word is a user-defined function or alias, skip NL detection.
    set -l word_type (type -t $first_word 2>/dev/null)
    if test "$word_type" = "function"; or test "$word_type" = "alias"
        set is_natural 0
    else
        # 1. Unmatched apostrophes that look like contractions (what's, don't, I'm)
        set -l singles (string replace -ra "[^']" '' $buf)
        set -l single_count (string length $singles)
        if test (math "$single_count % 2") -ne 0
            if string match -rq "[a-zA-Z]'[a-zA-Z]" $buf
                set is_natural 1
            end
        end

        # 2. Contains ? in a multi-word context
        if test $is_natural -eq 0; and string match -q '*?*' $buf
            set -l words (string split ' ' $buf)
            if test (count $words) -ge 2
                set is_natural 1
            end
        end

        # 3. Starts with a conversational word (2+ words only)
        if test $is_natural -eq 0; and string match -q '* *' $buf
            set -l lower_first (string lower $first_word)
            switch $lower_first
                case what how why where when who can could would should does did is are was were tell show explain help hey hi hello thanks thank please yo sup
                    set is_natural 1
            end
        end
    end

    # If it looks like natural language, route to ambient
    if test $is_natural -eq 1
        echo
        printf '\033[2m\033[33m  ambient \xe2\x86\x92 '
        $AMBIENT_BIN assist "$buf" 127 2>/dev/null
        printf '\033[0m\n'
        commandline ""
        commandline -f repaint
        return
    end

    # Not NL — check if we should auto-capture output for this command.
    # Skip if buffer contains shell metacharacters that would break wrapping.
    if not string match -qr '[|&;><\$`=]' $buf
        if _ambient_should_autocapture "$buf"
            commandline "rc $buf"
        end
    end

    commandline -f execute
end

bind \r _ambient_accept_line

# --- AI suggestion widget (Alt+A) ---
function _ambient_ai_suggest
    set -l input (commandline)
    test -z "$input"; and return

    # Show thinking indicator
    set -l original $input
    commandline "# (ambient: thinking...)"
    commandline -f repaint

    # Query the daemon synchronously (4s timeout prevents shell freeze)
    set -l result (timeout 4 $AMBIENT_BIN "Convert to a shell command: $input" 2>/dev/null)

    if test -n "$result"
        commandline "$result"
    else
        commandline "$original"
    end
    commandline -f end-of-line
    commandline -f repaint
end

bind \ea _ambient_ai_suggest

# --- Output capture (rc wrapper) ---
# Usage: rc pnpm build
# Captures output and sends to the daemon for context.
function rc
    set -l capture_file (mktemp /tmp/ambient-capture.XXXXXX)
    $argv 2>&1 | tee $capture_file
    set -l exit_code $pipestatus[1]
    fish -c "$AMBIENT_BIN capture < $capture_file" &>/dev/null &
    disown 2>/dev/null
    rm -f $capture_file
    return $exit_code
end

# --- command_not_found ---
function fish_command_not_found
    set -g _ambient_handled_by_cnf 1
    set -l response (timeout 4 $AMBIENT_BIN assist "$argv" 127 2>/dev/null)
    if test -n "$response"
        printf '\033[2m\033[33m  ambient \xe2\x86\x92 %s\033[0m\n' $response
    else
        printf 'fish: Unknown command: %s\n' $argv[1] >&2
    end
    return 127
end

# --- r command ---
# Override any existing `r` alias/function.
function r
    $AMBIENT_BIN $argv
end

# --- Reload: build + restart daemon + re-source shell in one shot ---
set -g _AMBIENT_ROOT "$_ambient_script_dir/.."
set -g _AMBIENT_SHELL (status filename)

function reload
    echo "Building..."
    pushd $_AMBIENT_ROOT
    pnpm build; or begin; echo "Build failed."; popd; return 1; end
    popd
    $AMBIENT_BIN daemon stop 2>/dev/null
    echo "Re-sourcing shell integration..."
    source $_AMBIENT_SHELL
    $AMBIENT_BIN daemon start 2>/dev/null
    echo "Done."
end

# --- Send initial context on shell startup ---
_ambient_refresh_git
_ambient_notify "{\"type\":\"context-update\",\"payload\":{\"event\":\"chpwd\",\"cwd\":\"$PWD\",\"gitBranch\":\"$_ambient_git_branch\",\"gitDirty\":$_ambient_git_dirty}}"
