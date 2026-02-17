import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installShellHooks, uninstallShellHooks, getShellScriptPath } from "../../src/setup/shell-install.js"

describe("shell-install", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ambient-shell-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("installShellHooks", () => {
    it("installs into empty file (creates it) and returns 'installed'", () => {
      const rcFile = join(tmpDir, ".bashrc")
      const scriptPath = "/path/to/ambient/shell/ambient.bash"

      const result = installShellHooks(rcFile, scriptPath)

      expect(result.status).toBe("installed")
      expect(result.shell).toBe("bash")
      expect(existsSync(rcFile)).toBe(true)

      const content = readFileSync(rcFile, "utf-8")
      expect(content).toContain("# --- ambient shell integration ---")
      expect(content).toContain(`source "${scriptPath}"`)
      expect(content).toContain("# --- /ambient ---")
    })

    it("installs into existing file, preserving content", () => {
      const rcFile = join(tmpDir, ".bashrc")
      writeFileSync(rcFile, "# My existing config\nalias ll='ls -la'\n")

      const result = installShellHooks(rcFile, "/path/to/ambient.bash")

      expect(result.status).toBe("installed")
      const content = readFileSync(rcFile, "utf-8")
      expect(content).toContain("# My existing config")
      expect(content).toContain("alias ll='ls -la'")
      expect(content).toContain("# --- ambient shell integration ---")
    })

    it("returns 'already-present' when markers exist", () => {
      const rcFile = join(tmpDir, ".bashrc")
      writeFileSync(rcFile, '# --- ambient shell integration ---\n[ -f "/x" ] && source "/x"\n# --- /ambient ---\n')

      const result = installShellHooks(rcFile, "/path/to/ambient.bash")

      expect(result.status).toBe("already-present")
    })

    it("uses fish-specific syntax for fish config", () => {
      const rcFile = join(tmpDir, "config.fish")
      const scriptPath = "/path/to/ambient/shell/ambient.fish"

      installShellHooks(rcFile, scriptPath)

      const content = readFileSync(rcFile, "utf-8")
      expect(content).toContain(`if test -f ${scriptPath}`)
      expect(content).toContain(`    source ${scriptPath}`)
      expect(content).toContain("end")
      // Should NOT contain bash-style syntax
      expect(content).not.toContain('[ -f')
    })

    it("uses bash/zsh syntax for zsh config", () => {
      const rcFile = join(tmpDir, ".zshrc")
      const scriptPath = "/path/to/ambient/shell/ambient.zsh"

      installShellHooks(rcFile, scriptPath)

      const content = readFileSync(rcFile, "utf-8")
      expect(content).toContain(`[ -f "${scriptPath}" ] && source "${scriptPath}"`)
    })

    it("creates parent directories if needed (fish config)", () => {
      const fishConfigDir = join(tmpDir, ".config", "fish")
      const rcFile = join(fishConfigDir, "config.fish")

      const result = installShellHooks(rcFile, "/path/to/ambient.fish")

      expect(result.status).toBe("installed")
      expect(existsSync(fishConfigDir)).toBe(true)
      expect(existsSync(rcFile)).toBe(true)
    })
  })

  describe("uninstallShellHooks", () => {
    it("removes markers and source line from rc file", () => {
      const rcFile = join(tmpDir, ".bashrc")
      const content = [
        "# My config",
        "alias ll='ls -la'",
        "# --- ambient shell integration ---",
        '[ -f "/path/to/ambient.bash" ] && source "/path/to/ambient.bash"',
        "# --- /ambient ---",
        "# More config",
        "",
      ].join("\n")
      writeFileSync(rcFile, content)

      const result = uninstallShellHooks(rcFile)

      // uninstall returns "installed" on success (meaning the operation was performed)
      expect(result.status).toBe("installed")
      const updated = readFileSync(rcFile, "utf-8")
      expect(updated).toContain("# My config")
      expect(updated).toContain("alias ll='ls -la'")
      expect(updated).toContain("# More config")
      expect(updated).not.toContain("ambient shell integration")
      expect(updated).not.toContain("/ambient ---")
    })

    it("returns 'skipped' when markers are not present", () => {
      const rcFile = join(tmpDir, ".bashrc")
      writeFileSync(rcFile, "# Just a normal bashrc\n")

      const result = uninstallShellHooks(rcFile)
      expect(result.status).toBe("skipped")
    })

    it("returns 'skipped' when file does not exist", () => {
      const rcFile = join(tmpDir, ".nonexistent")

      const result = uninstallShellHooks(rcFile)
      expect(result.status).toBe("skipped")
    })
  })

  describe("getShellScriptPath", () => {
    it("returns correct path for bash", () => {
      expect(getShellScriptPath("bash", "/opt/ambient")).toBe("/opt/ambient/shell/ambient.bash")
    })

    it("returns correct path for zsh", () => {
      expect(getShellScriptPath("zsh", "/opt/ambient")).toBe("/opt/ambient/shell/ambient.zsh")
    })

    it("returns correct path for fish", () => {
      expect(getShellScriptPath("fish", "/opt/ambient")).toBe("/opt/ambient/shell/ambient.fish")
    })
  })
})
