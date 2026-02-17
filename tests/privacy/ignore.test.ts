import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { IgnoreList } from "../../src/privacy/ignore.js"

describe("IgnoreList", () => {
  let tmpDir: string
  let ignoreFile: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ambient-ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    ignoreFile = join(tmpDir, "ignore")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("handles non-existent ignore file without crashing", () => {
    const list = new IgnoreList(join(tmpDir, "does-not-exist"))
    expect(list.getPatterns()).toEqual([])
    expect(list.isIgnored("/some/path")).toBe(false)
  })

  it("skips comments and blank lines", () => {
    writeFileSync(ignoreFile, [
      "# This is a comment",
      "",
      "/opt/secret",
      "  ",
      "# Another comment",
      "/opt/classified",
    ].join("\n"))

    const list = new IgnoreList(ignoreFile)
    expect(list.getPatterns()).toEqual(["/opt/secret", "/opt/classified"])
  })

  it("matches exact path prefixes", () => {
    writeFileSync(ignoreFile, "/opt/secret\n")
    const list = new IgnoreList(ignoreFile)

    expect(list.isIgnored("/opt/secret")).toBe(true)
    expect(list.isIgnored("/opt/secret/file.txt")).toBe(true)
    expect(list.isIgnored("/opt/secretive")).toBe(false)
    expect(list.isIgnored("/opt/other")).toBe(false)
  })

  it("expands ~ to homedir", () => {
    const home = homedir()
    writeFileSync(ignoreFile, "~/work/classified\n")
    const list = new IgnoreList(ignoreFile)

    expect(list.isIgnored(`${home}/work/classified`)).toBe(true)
    expect(list.isIgnored(`${home}/work/classified/deep/file.ts`)).toBe(true)
    expect(list.isIgnored(`${home}/work/other`)).toBe(false)
  })

  it("matches ** glob patterns", () => {
    writeFileSync(ignoreFile, "/tmp/secrets/**\n")
    const list = new IgnoreList(ignoreFile)

    expect(list.isIgnored("/tmp/secrets")).toBe(true)
    expect(list.isIgnored("/tmp/secrets/file.txt")).toBe(true)
    expect(list.isIgnored("/tmp/secrets/deep/nested/path")).toBe(true)
    expect(list.isIgnored("/tmp/other")).toBe(false)
  })

  it("matches basename patterns like *.env", () => {
    writeFileSync(ignoreFile, "*.env\n.secrets\n")
    const list = new IgnoreList(ignoreFile)

    expect(list.isIgnored("/project/.env")).toBe(true)
    expect(list.isIgnored("/project/prod.env")).toBe(true)
    expect(list.isIgnored("/project/.secrets")).toBe(true)
    expect(list.isIgnored("/project/environment")).toBe(false)
    expect(list.isIgnored("/project/.envrc")).toBe(false)
  })

  it("handles multiple patterns together", () => {
    writeFileSync(ignoreFile, [
      "# Private repos",
      "~/work/classified/**",
      "/opt/secret",
      "*.pem",
    ].join("\n"))
    const home = homedir()
    const list = new IgnoreList(ignoreFile)

    expect(list.isIgnored(`${home}/work/classified/src/main.ts`)).toBe(true)
    expect(list.isIgnored("/opt/secret/data")).toBe(true)
    expect(list.isIgnored("/project/cert.pem")).toBe(true)
    expect(list.isIgnored("/project/src/app.ts")).toBe(false)
  })
})
