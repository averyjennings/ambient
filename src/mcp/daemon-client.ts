import { connect } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { getSocketPath, getPidPath } from "../config.js"
import type { DaemonRequest, DaemonResponse } from "../types/index.js"

export interface DaemonResult {
  ok: boolean
  data: string | null
  error: string | null
}

/**
 * Check if the daemon process is alive by testing its PID file.
 */
export function isDaemonAlive(): boolean {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return false
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Send a request to the daemon over its Unix socket and collect the response.
 * Returns a structured result instead of writing to stdout.
 *
 * This follows the same IPC protocol as the CLI client:
 *   Request:  newline-delimited JSON
 *   Response: multiple "status"/"chunk" messages, ending with "done" or "error"
 */
export function sendDaemonRequest(
  request: DaemonRequest,
  timeoutMs = 3_000,
): Promise<DaemonResult> {
  return new Promise((resolve) => {
    const socketPath = getSocketPath()

    if (!isDaemonAlive()) {
      resolve({ ok: false, data: null, error: "daemon-not-running" })
      return
    }

    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ ok: false, data: null, error: "timeout" })
    }, timeoutMs)

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n")
    })

    let buffer = ""
    const statusChunks: string[] = []

    socket.on("data", (data) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line) as DaemonResponse
          switch (response.type) {
            case "status":
              statusChunks.push(response.data)
              break
            case "chunk":
              statusChunks.push(response.data)
              break
            case "error":
              clearTimeout(timer)
              socket.end()
              resolve({ ok: false, data: null, error: response.data })
              return
            case "done":
              clearTimeout(timer)
              socket.end()
              resolve({
                ok: true,
                data: statusChunks.join("") || response.data || null,
                error: null,
              })
              return
          }
        } catch {
          // Partial JSON — wait for more data
        }
      }
    })

    socket.on("error", (err) => {
      clearTimeout(timer)
      resolve({ ok: false, data: null, error: err.message })
    })
  })
}
