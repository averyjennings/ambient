import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { platform } from "node:os"

/**
 * Shell-escape a string using single-quote wrapping (POSIX).
 * Used on Linux where `script -c` takes a single command string.
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

/**
 * Spawn a command inside a pseudo-terminal so it uses line-buffering
 * instead of block-buffering. This dramatically improves streaming
 * latency when the spawned process writes to stdout.
 *
 * Uses the system `script` command (available on macOS and Linux) as a
 * zero-dependency PTY allocator. Falls back to regular `spawn` on
 * unsupported platforms or if `script` isn't available.
 *
 * How it works:
 *   macOS:  script -q /dev/null <command> <args...>
 *   Linux:  script -qec '<escaped-command>' /dev/null
 *
 * The PTY causes the child to line-buffer stdout, and `script` relays
 * that output to its own stdout (our pipe) immediately.
 */
export function spawnWithPty(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  const os = platform()

  if (os === "darwin") {
    // macOS: script -q /dev/null command arg1 arg2 ...
    return spawn("script", ["-q", "/dev/null", command, ...args], {
      ...options,
      // Ensure script inherits a sane environment
      env: { ...process.env, ...options?.env },
    })
  }

  if (os === "linux") {
    // Linux: script -qec 'command arg1 arg2' /dev/null
    // -e: pass through the child's exit code
    // -c: command string (requires shell escaping)
    const escapedCmd = [command, ...args].map(shellEscape).join(" ")
    return spawn("script", ["-qec", escapedCmd, "/dev/null"], {
      ...options,
      env: { ...process.env, ...options?.env },
    })
  }

  // Fallback: regular spawn (Windows or unknown platforms)
  return spawn(command, [...args], options ?? {})
}

/**
 * Strip PTY artifacts from output:
 * - \r\n → \n           (PTYs convert LF to CR+LF)
 * - ^D\b\b              (macOS script outputs literal "^D" + backspaces on stdin EOF)
 * - \x04                (raw EOT byte, just in case)
 * - standalone \b runs  (stray backspaces from PTY control)
 */
export function stripPtyArtifacts(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\^D\x08\x08/g, "")
    .replace(/\x04/g, "")
    .replace(/^\x08+/g, "")
}
