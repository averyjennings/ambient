import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Mock os.homedir() before importing the module
let mockHomeDir: string

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:os")
  return {
    ...actual,
    homedir: () => mockHomeDir,
  }
})

// Import after mock is set up
const { ensureAmbientInstructions } = await import("../../src/setup/claude-md.js")

describe("claude-md", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ambient-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    mockHomeDir = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ---- upsertSection behavior (tested via ensureAmbientInstructions) ----

  describe("ensureAmbientInstructions (upsertSection)", () => {
    it("creates file when it does not exist and returns 'added'", () => {
      const result = ensureAmbientInstructions()
      expect(result).toBe("added")

      const claudeMdPath = join(tmpDir, "CLAUDE.md")
      expect(existsSync(claudeMdPath)).toBe(true)

      const content = readFileSync(claudeMdPath, "utf-8")
      expect(content).toContain("ambient:memory-instructions")
      expect(content).toContain("Ambient Memory (REQUIRED)")
    })

    it("appends when file has no ambient markers", () => {
      const claudeMdPath = join(tmpDir, "CLAUDE.md")
      writeFileSync(claudeMdPath, "# My Project\n\nSome existing content.\n")

      const result = ensureAmbientInstructions()
      expect(result).toBe("added")

      const content = readFileSync(claudeMdPath, "utf-8")
      expect(content).toContain("# My Project")
      expect(content).toContain("Some existing content.")
      expect(content).toContain("ambient:memory-instructions")
    })

    it("replaces when version marker is outdated", () => {
      const claudeMdPath = join(tmpDir, "CLAUDE.md")
      const outdatedContent = `# My Config

<!-- ambient:memory-instructions -->
<!-- ambient:version:1 -->
## Old Instructions
Old content here.
<!-- /ambient:memory-instructions -->

# Other stuff
`
      writeFileSync(claudeMdPath, outdatedContent)

      const result = ensureAmbientInstructions()
      expect(result).toBe("updated")

      const content = readFileSync(claudeMdPath, "utf-8")
      expect(content).toContain("# My Config")
      expect(content).toContain("# Other stuff")
      // Old version should be gone
      expect(content).not.toContain("version:1")
      // New version should be present
      expect(content).toContain("version:4")
      expect(content).not.toContain("Old Instructions")
    })

    it("returns 'current' when already up to date", () => {
      // First call creates it
      ensureAmbientInstructions()

      // Second call should detect it's current
      const result = ensureAmbientInstructions()
      expect(result).toBe("current")
    })

    it("preserves surrounding content on update", () => {
      const claudeMdPath = join(tmpDir, "CLAUDE.md")
      const content = `# Header

Some important content above.

<!-- ambient:memory-instructions -->
<!-- ambient:version:2 -->
## Old section
<!-- /ambient:memory-instructions -->

Some important content below.
`
      writeFileSync(claudeMdPath, content)

      ensureAmbientInstructions()

      const updated = readFileSync(claudeMdPath, "utf-8")
      expect(updated).toContain("# Header")
      expect(updated).toContain("Some important content above.")
      expect(updated).toContain("Some important content below.")
      expect(updated).toContain("version:4")
    })

    it("resolves to ~/.claude/CLAUDE.md when that exists instead of ~/CLAUDE.md", () => {
      // Create ~/.claude/CLAUDE.md
      mkdirSync(join(tmpDir, ".claude"), { recursive: true })
      writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "# Existing in .claude\n")

      const result = ensureAmbientInstructions()
      expect(result).toBe("added")

      // Should have been written to .claude path, not home
      const dotClaudeContent = readFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "utf-8")
      expect(dotClaudeContent).toContain("ambient:memory-instructions")

      // ~/CLAUDE.md should NOT exist
      expect(existsSync(join(tmpDir, "CLAUDE.md"))).toBe(false)
    })
  })
})
