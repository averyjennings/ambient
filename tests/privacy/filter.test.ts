import { describe, it, expect } from "vitest"
import { sanitizeCommand, sanitizeText, containsSensitiveData } from "../../src/privacy/filter.js"

describe("sanitizeCommand", () => {
  it("redacts inline password assignments", () => {
    expect(sanitizeCommand("password=hunter2")).toBe("password=[REDACTED]")
    expect(sanitizeCommand("token: abc123xyz")).toBe("token:[REDACTED]")
    expect(sanitizeCommand("api_key=sk-something")).toBe("api_key=[REDACTED]")
    expect(sanitizeCommand("secret = super_secret_value")).toBe("secret =[REDACTED]")
  })

  it("redacts environment variable exports", () => {
    const result = sanitizeCommand("export ANTHROPIC_API_KEY=sk-ant-api03-xyz")
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain("sk-ant-api03-xyz")
  })

  it("redacts AWS secret keys", () => {
    const result = sanitizeCommand("export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain("wJalrXUtnFEMI")
  })

  it("redacts known token prefixes", () => {
    expect(sanitizeCommand("curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890'"))
      .toContain("[REDACTED]")

    expect(sanitizeCommand("echo xoxb-123-456-abc"))
      .toContain("[REDACTED]")
  })

  it("redacts github PAT tokens", () => {
    const result = sanitizeCommand("GITHUB_TOKEN=github_pat_abcdefghijklmnopqrstuv")
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain("github_pat_")
  })

  it("redacts --password flags", () => {
    expect(sanitizeCommand("mysql --password mypass123 -u root")).toContain("[REDACTED]")
    expect(sanitizeCommand("docker run -p 8080:80 -e PASSWORD=x")).toContain("[REDACTED]")
  })

  it("blocks sensitive file reading commands", () => {
    expect(sanitizeCommand("cat ~/.ssh/id_rsa")).toBe("[sensitive command redacted]")
    expect(sanitizeCommand("cat /home/user/.gnupg/private-keys-v1.d/key")).toBe("[sensitive command redacted]")
    expect(sanitizeCommand("cat /path/to/credentials")).toBe("[sensitive command redacted]")
  })

  it("blocks printenv grep for secrets", () => {
    expect(sanitizeCommand("printenv | grep token")).toBe("[sensitive command redacted]")
    expect(sanitizeCommand("printenv | grep secret")).toBe("[sensitive command redacted]")
  })

  it("leaves normal commands unchanged", () => {
    expect(sanitizeCommand("git status")).toBe("git status")
    expect(sanitizeCommand("npm install react")).toBe("npm install react")
    expect(sanitizeCommand("ls -la")).toBe("ls -la")
    expect(sanitizeCommand("pnpm test")).toBe("pnpm test")
    expect(sanitizeCommand("cd ~/projects/my-app")).toBe("cd ~/projects/my-app")
  })

  it("leaves normal multi-word commands unchanged", () => {
    expect(sanitizeCommand("docker build -t myapp .")).toBe("docker build -t myapp .")
    expect(sanitizeCommand("git commit -m 'fix bug'")).toBe("git commit -m 'fix bug'")
  })
})

describe("sanitizeText", () => {
  it("redacts Anthropic API key tokens in text", () => {
    const text = "The key sk-ant-api03-abcdefghijklmnopqrstuvwxyz was leaked"
    expect(sanitizeText(text)).toContain("[REDACTED]")
    expect(sanitizeText(text)).not.toContain("sk-ant-api03")
  })

  it("redacts GitHub tokens in text", () => {
    const text = "Found token ghp_abcdefghijklmnopqrstuvwxyz1234567890 in logs"
    expect(sanitizeText(text)).toContain("[REDACTED]")
  })

  it("leaves normal text unchanged", () => {
    expect(sanitizeText("This is just a normal sentence about APIs.")).toBe("This is just a normal sentence about APIs.")
    expect(sanitizeText("The password field should be required")).toBe("The password field should be required")
  })
})

describe("containsSensitiveData", () => {
  it("returns true for commands with secrets", () => {
    expect(containsSensitiveData("export ANTHROPIC_API_KEY=sk-ant-xxx")).toBe(true)
    expect(containsSensitiveData("password=hunter2")).toBe(true)
  })

  it("returns false for normal commands", () => {
    expect(containsSensitiveData("git status")).toBe(false)
    expect(containsSensitiveData("npm install")).toBe(false)
  })
})
