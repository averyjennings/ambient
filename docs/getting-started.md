# Getting Started

## Prerequisites

- **Node.js >= 20** -- ambient uses ESM and modern Node APIs
- **A supported shell** -- zsh, bash 4+, or fish 3.1+
- **ANTHROPIC_API_KEY** (optional) -- needed for auto-assist and memory extraction. Without it, ambient still works as a context layer and agent router. For fully local operation, use Ollama instead.

## Installation

### From Source

```bash
git clone https://github.com/averyjennings/ambient.git
cd ambient
pnpm install
pnpm build
```

### Link the CLI

```bash
pnpm link --global
```

This makes `r` and `ambient` available globally.

### Shell Integration

Add the appropriate line to your shell's config file:

**zsh** (add to `~/.zshrc`):

```bash
source /path/to/ambient/shell/ambient.zsh
```

**bash 4+** (add to `~/.bashrc`):

```bash
[ -f /path/to/ambient/shell/ambient.bash ] && source /path/to/ambient/shell/ambient.bash
```

**fish 3.1+** (add to `~/.config/fish/config.fish`):

```fish
if test -f /path/to/ambient/shell/ambient.fish
    source /path/to/ambient/shell/ambient.fish
end
```

Then reload your shell:

```bash
source ~/.zshrc  # or open a new terminal
```

### Set Up Agent Integrations

```bash
ambient setup
```

This injects ambient's memory instructions into `~/.claude/CLAUDE.md` and registers Claude Code hooks so agents automatically use ambient's context on every session.

To create instruction files for other agents:

```bash
ambient setup --agents codex,gemini,copilot
```

## Your First Session

The daemon starts automatically on first use. Try these:

**Ask a question about your project:**

```
r "what does this project do"
```

The daemon starts (if not already running), builds context from your cwd and git state, sends it to the default agent, and streams the response.

**Review uncommitted changes:**

```
r review
```

This runs the `review` template: executes `git diff`, pipes the output as context, and asks the agent to review your changes.

**Generate a commit message:**

```
r commit
```

Runs `git diff --cached` and generates a commit message for your staged changes.

**Capture build output:**

```
rc pnpm build
```

The `rc` wrapper runs the command normally but captures its output. If the build fails, the next query will automatically include the error output.

**Fix the last error:**

```
r fix
```

The agent sees the recent failure, the captured output, and your shell context. It explains what went wrong and shows the fix.

**Store a decision:**

```
r remember "chose JWT with refresh tokens for auth"
```

This creates a high-importance memory event that persists across sessions and survives branch switches.

**Type natural language directly (zsh and fish only):**

```
what does the auth module do
```

The shell hooks detect this as natural language (not a command) and route it to ambient's inline assist for an instant answer.

## How Memory Works

Ambient maintains two levels of memory:

- **Project memory** -- shared across all branches. Stores high-importance decisions that survive branch deletion.
- **Task memory** -- scoped to the current branch. Stores everything else. When a branch is merged, high-importance events are promoted to project memory and the task file is archived.

Memories are created three ways: explicitly (`r remember "..."`), automatically from shell activity (git commits, build failures), and via LLM extraction from agent responses.

For the full details, see [How Memory Works](memory-guide.md).

## Choosing Agents

List available agents (checks which CLIs are installed on your system):

```
r agents
```

Use a specific agent:

```
r -a codex "write tests for auth.ts"
r -a gemini "summarize the architecture"
```

Set your default agent in `~/.ambient/config.json`:

```json
{
  "defaultAgent": "claude"
}
```

Set to `"auto"` for ambient to pick the best agent based on query keywords and agent capabilities.

## Templates

Templates combine a prompt with an optional command whose output is piped as context.

**Built-in templates:**

| Template | What it does |
|----------|-------------|
| `review` | Runs `git diff`, asks for a code review |
| `review-staged` | Runs `git diff --cached`, reviews staged changes |
| `commit` | Runs `git diff --cached`, generates a commit message |
| `fix` | Asks agent to fix the last failed command |
| `test` | Asks agent to generate tests |
| `explain` | Asks agent to explain code or output |

List all templates:

```
r templates
```

Add custom templates in `~/.ambient/config.json`:

```json
{
  "templates": {
    "security": {
      "command": "git diff",
      "prompt": "Audit these changes for security vulnerabilities.",
      "description": "Security review of changes"
    }
  }
}
```

## Configuration

Configuration lives at `~/.ambient/config.json`. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `defaultAgent` | `"claude"` | Default agent for queries (`"auto"` for auto-selection) |
| `logLevel` | `"info"` | Daemon log verbosity |
| `templates` | (built-ins) | Custom templates merged with built-ins |
| `privacy.localOnly` | `false` | Disable all API calls |
| `privacy.passiveMonitoring` | `true` | Enable/disable passive monitoring |
| `llm.provider` | `"anthropic"` | LLM provider for assist/extraction |
| `llm.model` | `"claude-haiku-4-5-20251001"` | Model for fast LLM calls |
| `dailyBudgetUsd` | (none) | Daily API cost limit |

View config paths:

```
r config
```

## LLM Providers

Ambient uses a fast LLM for inline assist, memory extraction, and compaction. This is separate from the agents you invoke with `r "query"`.

### Anthropic (default)

Set `ANTHROPIC_API_KEY` in your environment. No config changes needed.

### Ollama (fully local)

Install [Ollama](https://ollama.ai), pull a model, then configure:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "llama3.2"
  }
}
```

No API key needed. All LLM calls stay on your machine.

### OpenAI-compatible

For any endpoint that speaks the OpenAI chat completions API:

```json
{
  "llm": {
    "provider": "openai-compat",
    "baseUrl": "https://your-endpoint.com/v1",
    "model": "your-model"
  }
}
```

Set `OPENAI_API_KEY` in your environment.

## Troubleshooting

**Daemon not starting**

```
ambient health
```

This checks daemon status, socket, API key, memory directory, Claude hooks, and log file. Fix any failing checks.

**Agent not found**

```
r agents
```

Shows which agents are installed. Make sure the agent's CLI is on your `PATH`.

**No API key**

Set `ANTHROPIC_API_KEY` in your environment, or configure Ollama for local operation. Without a key, auto-assist and memory extraction are disabled but agent routing still works.

**Shell hooks not loading**

Verify the `source` line is in your rc file and the path is correct. Open a new terminal and check that `r --help` works.

**Memory not persisting**

Check that `~/.ambient/memory/` exists and is writable. Run `ambient memories stats` to see stored events.

**Checking logs**

```
r logs           # last 50 lines
r logs -f        # follow in real-time
r logs -n 200    # last 200 lines
```
