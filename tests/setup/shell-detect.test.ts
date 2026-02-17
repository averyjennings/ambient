import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "node:path"

// Store original SHELL env
const originalShell = process.env["SHELL"]

// Mock child_process for version detection and command existence
let mockExecResults: Record<string, string>
let mockExecThrows: Set<string>

vi.mock("node:child_process", () => ({
  execFileSync: (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(" ")}`
    if (mockExecThrows.has(key)) {
      throw new Error(`not found: ${cmd}`)
    }
    return mockExecResults[key] ?? ""
  },
}))

// Mock homedir
const mockHome = "/mock/home"
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:os")
  return { ...actual, homedir: () => mockHome }
})

const { detectShell, detectAllShells, versionAtLeast } = await import("../../src/setup/shell-detect.js")

describe("shell-detect", () => {
  beforeEach(() => {
    mockExecResults = {}
    mockExecThrows = new Set()
  })

  afterEach(() => {
    // Restore SHELL
    if (originalShell !== undefined) {
      process.env["SHELL"] = originalShell
    } else {
      delete process.env["SHELL"]
    }
  })

  describe("detectShell", () => {
    it("detects zsh from $SHELL", () => {
      process.env["SHELL"] = "/bin/zsh"
      mockExecResults["zsh --version"] = "zsh 5.9 (x86_64-apple-darwin23.0)"

      const info = detectShell()
      expect(info.shell).toBe("zsh")
      expect(info.rcFile).toBe(join(mockHome, ".zshrc"))
      expect(info.version).toBe("5.9")
      expect(info.meetsMinVersion).toBe(true)
    })

    it("detects bash from $SHELL", () => {
      process.env["SHELL"] = "/bin/bash"
      mockExecResults["bash --version"] = "GNU bash, version 5.2.15(1)-release"

      const info = detectShell()
      expect(info.shell).toBe("bash")
      expect(info.rcFile).toBe(join(mockHome, ".bashrc"))
      expect(info.version).toBe("5.2.15")
      expect(info.meetsMinVersion).toBe(true)
    })

    it("detects fish from $SHELL", () => {
      process.env["SHELL"] = "/usr/local/bin/fish"
      mockExecResults["fish --version"] = "fish, version 3.7.1"

      const info = detectShell()
      expect(info.shell).toBe("fish")
      expect(info.rcFile).toBe(join(mockHome, ".config", "fish", "config.fish"))
      expect(info.version).toBe("3.7.1")
      expect(info.meetsMinVersion).toBe(true)
    })

    it("returns unknown for unrecognized shell", () => {
      process.env["SHELL"] = "/bin/tcsh"

      const info = detectShell()
      expect(info.shell).toBe("unknown")
      expect(info.rcFile).toBe("")
      expect(info.version).toBeNull()
      expect(info.meetsMinVersion).toBe(false)
    })

    it("returns unknown when $SHELL is not set", () => {
      delete process.env["SHELL"]

      const info = detectShell()
      expect(info.shell).toBe("unknown")
    })

    it("reports bash 3.x as not meeting min version", () => {
      process.env["SHELL"] = "/bin/bash"
      mockExecResults["bash --version"] = "GNU bash, version 3.2.57(1)-release"

      const info = detectShell()
      expect(info.shell).toBe("bash")
      expect(info.version).toBe("3.2.57")
      expect(info.meetsMinVersion).toBe(false)
    })

    it("reports fish 2.x as not meeting min version", () => {
      process.env["SHELL"] = "/usr/local/bin/fish"
      mockExecResults["fish --version"] = "fish, version 2.7.1"

      const info = detectShell()
      expect(info.shell).toBe("fish")
      expect(info.version).toBe("2.7.1")
      expect(info.meetsMinVersion).toBe(false)
    })
  })

  describe("detectAllShells", () => {
    it("returns all installed shells", () => {
      mockExecResults["which zsh"] = "/bin/zsh"
      mockExecResults["zsh --version"] = "zsh 5.9"
      mockExecResults["which bash"] = "/bin/bash"
      mockExecResults["bash --version"] = "GNU bash, version 5.2.15(1)-release"
      mockExecResults["which fish"] = "/usr/local/bin/fish"
      mockExecResults["fish --version"] = "fish, version 3.7.1"

      const shells = detectAllShells()
      expect(shells).toHaveLength(3)
      expect(shells.map(s => s.shell)).toEqual(["zsh", "bash", "fish"])
    })

    it("skips shells that are not installed", () => {
      mockExecResults["which zsh"] = "/bin/zsh"
      mockExecResults["zsh --version"] = "zsh 5.9"
      mockExecThrows.add("which bash")
      mockExecThrows.add("which fish")

      const shells = detectAllShells()
      expect(shells).toHaveLength(1)
      expect(shells[0]!.shell).toBe("zsh")
    })
  })

  describe("versionAtLeast", () => {
    it("returns false for null version", () => {
      expect(versionAtLeast(null, "4.0")).toBe(false)
    })

    it("returns true when major is higher", () => {
      expect(versionAtLeast("5.0", "4.0")).toBe(true)
    })

    it("returns true when version equals minimum", () => {
      expect(versionAtLeast("4.0", "4.0")).toBe(true)
    })

    it("returns true when minor is higher", () => {
      expect(versionAtLeast("4.3", "4.0")).toBe(true)
    })

    it("returns false when major is lower", () => {
      expect(versionAtLeast("3.9", "4.0")).toBe(false)
    })

    it("returns false when minor is lower with same major", () => {
      expect(versionAtLeast("3.0", "3.1")).toBe(false)
    })

    it("handles three-part version strings", () => {
      expect(versionAtLeast("5.2.15", "4.0")).toBe(true)
      expect(versionAtLeast("3.2.57", "4.0")).toBe(false)
    })
  })
})
