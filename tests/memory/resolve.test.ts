import { describe, it, expect } from "vitest"
import { sanitizeBranchName } from "../../src/memory/resolve.js"

describe("sanitizeBranchName", () => {
  it("replaces slashes with double dashes", () => {
    expect(sanitizeBranchName("feature/memory-system")).toBe("feature--memory-system")
  })

  it("handles nested slashes", () => {
    expect(sanitizeBranchName("user/feature/sub-task")).toBe("user--feature--sub-task")
  })

  it("strips unsafe characters", () => {
    expect(sanitizeBranchName("fix/#123-bug")).toBe("fix--123-bug")
  })

  it("returns 'default' for empty string", () => {
    expect(sanitizeBranchName("")).toBe("default")
  })

  it("returns 'default' for string that sanitizes to empty", () => {
    expect(sanitizeBranchName("###")).toBe("default")
  })

  it("preserves dots, underscores, and hyphens", () => {
    expect(sanitizeBranchName("v1.0_release-candidate")).toBe("v1.0_release-candidate")
  })

  it("truncates to 100 characters", () => {
    const longBranch = "a".repeat(150)
    expect(sanitizeBranchName(longBranch)).toHaveLength(100)
  })

  it("handles main/master as-is", () => {
    expect(sanitizeBranchName("main")).toBe("main")
    expect(sanitizeBranchName("master")).toBe("master")
  })

  it("handles detached state", () => {
    expect(sanitizeBranchName("detached")).toBe("detached")
  })
})
