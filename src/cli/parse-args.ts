export interface ParsedCommand {
  command: string
  subcommand?: string
  args: string[]
  flags: {
    agent?: string
    newSession?: boolean
    help?: boolean
    type?: string
    importance?: string
  }
  prompt?: string
  stdinContent?: string
}

/**
 * Parse CLI arguments into a structured command object.
 * Handles all subcommands and flags recognized by the ambient CLI.
 */
export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", args: [], flags: { help: true } }
  }

  const first = argv[0]!

  // Direct subcommands with no further parsing needed
  const simpleCommands = new Set([
    "mcp-serve", "setup", "suggest", "capture", "new", "agents", "config",
    "templates", "memory",
  ])

  if (simpleCommands.has(first)) {
    const remaining = argv.slice(1)

    // "setup" may have --agents flag
    if (first === "setup") {
      const agentsIdx = remaining.indexOf("--agents")
      return {
        command: "setup",
        args: remaining,
        flags: {
          agent: agentsIdx !== -1 ? remaining[agentsIdx + 1] : undefined,
        },
      }
    }

    return { command: first, args: remaining, flags: {} }
  }

  // Daemon subcommand
  if (first === "daemon") {
    const sub = argv[1]
    return {
      command: "daemon",
      subcommand: sub,
      args: argv.slice(2),
      flags: {},
    }
  }

  // Notify (fire-and-forget)
  if (first === "notify") {
    return {
      command: "notify",
      args: argv.slice(1),
      flags: {},
      prompt: argv.slice(1).join(" "),
    }
  }

  // Assist
  if (first === "assist") {
    return {
      command: "assist",
      args: argv.slice(1),
      flags: {},
      prompt: argv[1],
    }
  }

  // Compare
  if (first === "compare") {
    const compareArgs = argv.slice(1)
    let agents: string | undefined
    const promptParts: string[] = []

    for (let i = 0; i < compareArgs.length; i++) {
      if ((compareArgs[i] === "--agents" || compareArgs[i] === "-a") && compareArgs[i + 1]) {
        agents = compareArgs[i + 1]
        i++
      } else {
        promptParts.push(compareArgs[i]!)
      }
    }

    return {
      command: "compare",
      args: compareArgs,
      flags: { agent: agents },
      prompt: promptParts.join(" "),
    }
  }

  // Remember
  if (first === "remember") {
    const memArgs = argv.slice(1)
    let eventType: string | undefined
    let importance: string | undefined
    const contentParts: string[] = []

    for (let i = 0; i < memArgs.length; i++) {
      if (memArgs[i] === "--type" && memArgs[i + 1]) {
        eventType = memArgs[i + 1]
        i++
      } else if (memArgs[i] === "--importance" && memArgs[i + 1]) {
        importance = memArgs[i + 1]
        i++
      } else {
        contentParts.push(memArgs[i]!)
      }
    }

    return {
      command: "remember",
      args: memArgs,
      flags: { type: eventType, importance },
      prompt: contentParts.join(" "),
    }
  }

  // Default: query mode — parse --agent, --new, and collect prompt words
  let agentName: string | undefined
  let newSession = false
  const queryArgs: string[] = []

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--agent" || argv[i] === "-a") && argv[i + 1]) {
      agentName = argv[i + 1]
      i++
    } else if (argv[i] === "--new" || argv[i] === "-n") {
      newSession = true
    } else {
      queryArgs.push(argv[i]!)
    }
  }

  return {
    command: "query",
    args: queryArgs,
    flags: {
      agent: agentName,
      newSession,
    },
    prompt: queryArgs.join(" "),
  }
}
