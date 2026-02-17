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
const { ensureAmbientInstructions, ensureProjectInstructions, initProjectInstructions, SUPPORTED_AGENTS } = await import("../../src/setup/claude-md.js")

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
      expect(content).toContain("version:3")
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
      expect(updated).toContain("version:3")
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

  // ---- ensureProjectInstructions ----

  describe("ensureProjectInstructions", () => {
    it("only updates existing files, does not create new ones", () => {
      const projectDir = join(tmpDir, "my-project")
      mkdirSync(projectDir, { recursive: true })

      // Create ONLY a CLAUDE.md in the project
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Project\n")

      const result = ensureProjectInstructions(projectDir)

      // CLAUDE.md should be updated
      expect(result.updated).toContain("CLAUDE.md")

      // Other instruction files should NOT have been created
      expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false)
      expect(existsSync(join(projectDir, "GEMINI.md"))).toBe(false)
      expect(existsSync(join(projectDir, ".goosehints"))).toBe(false)
    })

    it("returns current for files already up to date", () => {
      const projectDir = join(tmpDir, "my-project")
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Project\n")

      // First call updates
      ensureProjectInstructions(projectDir)

      // Second call should detect they're current
      const result = ensureProjectInstructions(projectDir)
      expect(result.current).toContain("CLAUDE.md")
      expect(result.updated).toHaveLength(0)
    })

    it("updates multiple existing instruction files", () => {
      const projectDir = join(tmpDir, "multi-agent")
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, "CLAUDE.md"), "# Claude\n")
      writeFileSync(join(projectDir, "AGENTS.md"), "# Codex\n")
      writeFileSync(join(projectDir, ".goosehints"), "# Goose\n")

      const result = ensureProjectInstructions(projectDir)
      expect(result.updated).toContain("CLAUDE.md")
      expect(result.updated).toContain("AGENTS.md")
      expect(result.updated).toContain(".goosehints")
    })

    it("handles empty project directory gracefully", () => {
      const projectDir = join(tmpDir, "empty-project")
      mkdirSync(projectDir, { recursive: true })

      const result = ensureProjectInstructions(projectDir)
      expect(result.updated).toHaveLength(0)
      expect(result.current).toHaveLength(0)
    })
  })

  // ---- initProjectInstructions ----

  describe("initProjectInstructions", () => {
    it("creates files for specified agents", () => {
      const projectDir = join(tmpDir, "new-project")
      mkdirSync(projectDir, { recursive: true })

      const created = initProjectInstructions(projectDir, ["codex", "gemini"])

      expect(created).toContain("AGENTS.md")
      expect(created).toContain("GEMINI.md")
      expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true)
      expect(existsSync(join(projectDir, "GEMINI.md"))).toBe(true)
    })

    it("maps agent names to correct file paths", () => {
      const projectDir = join(tmpDir, "mapping-test")
      mkdirSync(projectDir, { recursive: true })

      initProjectInstructions(projectDir, ["claude"])
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true)

      initProjectInstructions(projectDir, ["copilot"])
      expect(existsSync(join(projectDir, ".github", "copilot-instructions.md"))).toBe(true)

      initProjectInstructions(projectDir, ["cursor"])
      expect(existsSync(join(projectDir, ".cursorrules"))).toBe(true)

      initProjectInstructions(projectDir, ["windsurf"])
      expect(existsSync(join(projectDir, ".windsurfrules"))).toBe(true)

      initProjectInstructions(projectDir, ["goose"])
      expect(existsSync(join(projectDir, ".goosehints"))).toBe(true)
    })

    it("ignores unknown agent names", () => {
      const projectDir = join(tmpDir, "unknown-agents")
      mkdirSync(projectDir, { recursive: true })

      const created = initProjectInstructions(projectDir, ["unknown-agent", "nonexistent"])
      expect(created).toHaveLength(0)
    })

    it("handles case-insensitive agent names", () => {
      const projectDir = join(tmpDir, "case-test")
      mkdirSync(projectDir, { recursive: true })

      const created = initProjectInstructions(projectDir, ["CODEX", "Gemini"])
      expect(created).toContain("AGENTS.md")
      expect(created).toContain("GEMINI.md")
    })

    it("created files contain ambient memory instructions", () => {
      const projectDir = join(tmpDir, "content-check")
      mkdirSync(projectDir, { recursive: true })

      initProjectInstructions(projectDir, ["codex"])

      const content = readFileSync(join(projectDir, "AGENTS.md"), "utf-8")
      expect(content).toContain("ambient:memory-instructions")
      expect(content).toContain("Ambient Memory (REQUIRED)")
    })
  })

  // ---- SUPPORTED_AGENTS constant ----

  describe("SUPPORTED_AGENTS", () => {
    it("includes expected agent names", () => {
      expect(SUPPORTED_AGENTS).toContain("claude")
      expect(SUPPORTED_AGENTS).toContain("codex")
      expect(SUPPORTED_AGENTS).toContain("gemini")
      expect(SUPPORTED_AGENTS).toContain("copilot")
      expect(SUPPORTED_AGENTS).toContain("cursor")
      expect(SUPPORTED_AGENTS).toContain("windsurf")
      expect(SUPPORTED_AGENTS).toContain("goose")
    })
  })
})
