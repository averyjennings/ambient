/**
 * `ambient memories` — browse, search, edit, delete, export/import memory events.
 * Reads directly from disk (works even when daemon is down).
 */
import { createInterface } from "node:readline"
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { resolveMemoryKey } from "../memory/resolve.js"
import {
  listAllMemoryEvents, listAllProjects, loadProjectMemory, loadTaskMemory,
  listTaskKeys, deleteMemoryEvent, updateMemoryEvent,
  addProjectEvent, addTaskEvent, extractKeywords, getProjectDir,
} from "../memory/store.js"
import type { MemoryEvent } from "../types/index.js"

// --- ANSI helpers ---
const B = "\x1b[1m", D = "\x1b[2m", R = "\x1b[0m"
const TYPE_COLOR: Record<string, string> = {
  "decision": "\x1b[36m", "error-resolution": "\x1b[31m", "task-update": "\x1b[32m",
  "file-context": "\x1b[33m", "session-summary": "\x1b[35m",
}
const ct = (t: string) => `${TYPE_COLOR[t] ?? ""}${t}${R}`
const ci = (i: string) => i === "high" ? `${B}${i}${R}` : i === "low" ? `${D}${i}${R}` : i

function timeAgo(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// --- Arg helpers ---
const getFlag = (a: string[], f: string) => { const i = a.indexOf(f); return i !== -1 && i + 1 < a.length ? a[i + 1] : undefined }
const hasFlag = (a: string[], f: string) => a.includes(f)

function parseSince(spec: string): number {
  const m = spec.match(/^(\d+)([dhm])$/)
  if (m) return Date.now() - parseInt(m[1]!, 10) * (m[2] === "d" ? 86400000 : m[2] === "h" ? 3600000 : 60000)
  const p = Date.parse(spec)
  if (!isNaN(p)) return p
  console.error(`Invalid --since: ${spec}. Use ISO date or relative (7d, 24h, 30m).`)
  process.exit(1)
}

// --- Shared: collect all events across all projects ---
interface CollectedEvent { event: MemoryEvent; projectName: string; branchName: string; searchText: string }

function collectAllEvents(): CollectedEvent[] {
  const items: CollectedEvent[] = []
  for (const pk of listAllProjects()) {
    const proj = loadProjectMemory(pk)
    if (!proj) continue
    for (const e of proj.events) {
      items.push({ event: e, projectName: proj.projectName, branchName: "", searchText: `${proj.projectName} ${e.content}`.toLowerCase() })
    }
    for (const tk of listTaskKeys(pk)) {
      const task = loadTaskMemory(pk, tk)
      if (!task) continue
      for (const e of task.events) {
        items.push({ event: e, projectName: proj.projectName, branchName: task.branchName, searchText: `${proj.projectName} ${task.branchName} ${e.content}`.toLowerCase() })
      }
    }
  }
  return items
}

// --- Find event by ID or prefix ---
function findEvent(eventId: string) {
  const memKey = resolveMemoryKey(process.cwd())
  const all = listAllMemoryEvents(memKey)
  const match = all.find((e) => e.event.id === eventId || e.event.id.startsWith(eventId))
  return { memKey, match }
}

// --- Main router ---
export async function handleMemoriesCommand(args: string[]): Promise<void> {
  const sub = args[0]
  if (!sub || sub.startsWith("--")) { handleList(args); return }
  switch (sub) {
    case "search": handleSearch(args.slice(1)); return
    case "delete": await handleDelete(args.slice(1)); return
    case "edit": await handleEdit(args.slice(1)); return
    case "export": handleExport(args.slice(1)); return
    case "import": handleImport(args.slice(1)); return
    case "stats": handleStats(); return
    default: console.error(`Unknown subcommand: ${sub}`); printUsage(); process.exit(1)
  }
}

// --- List ---
function handleList(args: string[]): void {
  const typeFilter = getFlag(args, "--type")
  const impFilter = getFlag(args, "--importance")
  const sinceSpec = getFlag(args, "--since")
  const scope = (getFlag(args, "--scope") ?? "both") as "project" | "task" | "both"
  const showAll = hasFlag(args, "--all"), json = hasFlag(args, "--json")

  const memKey = resolveMemoryKey(process.cwd())
  let events = listAllMemoryEvents(memKey, { scope, type: typeFilter })
  if (impFilter) events = events.filter((e) => e.event.importance === impFilter)
  if (sinceSpec) { const ts = parseSince(sinceSpec); events = events.filter((e) => e.event.timestamp >= ts) }
  if (json) { console.log(JSON.stringify(events, null, 2)); return }

  const display = showAll ? events : events.slice(0, 20)
  console.log(`\n${B}Memories for ${memKey.projectName} (${memKey.branchName})${R} — ${events.length} events\n`)
  if (display.length === 0) console.log(`  ${D}No events found.${R}`)
  for (const { event: e, source } of display) {
    console.log(`  [${ct(e.type)}] [${ci(e.importance)}] ${D}${timeAgo(e.timestamp)}${R}  ${D}id=${e.id.slice(0, 8)}${R} ${D}[${source}]${R}`)
    console.log(`    ${e.content.slice(0, 200)}\n`)
  }
  if (!showAll && events.length > 20) console.log(`  ${D}... showing 20 of ${events.length} — use --all to show all${R}\n`)
}

// --- Search ---
function handleSearch(args: string[]): void {
  const query = args.filter((a) => !a.startsWith("--")).join(" ")
  const limit = parseInt(getFlag(args, "--limit") ?? "25", 10)
  const json = hasFlag(args, "--json")
  if (!query) { console.error("Usage: ambient memories search <query> [--limit N] [--json]"); process.exit(1) }

  const items = collectAllEvents()
  if (items.length === 0) { console.log("No memory events found."); return }

  const keywords = extractKeywords(query)
  const idf = new Map<string, number>()
  for (const kw of keywords) {
    let df = 0
    for (const it of items) { if (it.searchText.includes(kw)) df++ }
    idf.set(kw, Math.log((1 + items.length) / (1 + df)))
  }

  const scored = items.map((item) => {
    let tf = 0
    for (const kw of keywords) { if (item.searchText.includes(kw)) tf += idf.get(kw) ?? 0 }
    if (item.event.importance === "high") tf *= 1.5
    const rec = 1 / (1 + (Date.now() - item.event.timestamp) / 86_400_000)
    return { ...item, tf, rec }
  })
  const maxTf = Math.max(...scored.map((s) => s.tf), 0.001)
  const results = (keywords.length > 0 ? scored.filter((s) => s.tf > 0) : scored)
    .map((s) => ({ ...s, score: keywords.length > 0 ? 0.5 * s.rec + 0.5 * (s.tf / maxTf) : s.rec }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  if (json) {
    console.log(JSON.stringify(results.map((s) => ({ score: +s.score.toFixed(2), event: s.event, projectName: s.projectName, branchName: s.branchName })), null, 2))
    return
  }
  console.log(`\n${B}Search: "${query}"${R} — ${results.length} results\n`)
  for (const { score, event: e, projectName, branchName } of results) {
    const src = branchName ? `${projectName} (${branchName})` : projectName
    console.log(`  ${B}${score.toFixed(2)}${R}  [${ct(e.type)}] [${ci(e.importance)}] ${D}${src}${R} ${D}${timeAgo(e.timestamp)}${R}`)
    console.log(`        ${e.content.slice(0, 200)}\n`)
  }
}

// --- Delete ---
async function handleDelete(args: string[]): Promise<void> {
  const eventId = args.find((a) => !a.startsWith("--"))
  if (!eventId) { console.error("Usage: ambient memories delete <event-id> [--force]"); process.exit(1) }
  const { memKey, match } = findEvent(eventId)
  if (!match) { console.error(`Event not found: ${eventId}`); process.exit(1) }

  const e = match.event
  console.log(`\nAbout to delete:\n  [${ct(e.type)}] [${ci(e.importance)}] ${timeAgo(e.timestamp)}\n  ${e.content.slice(0, 200)}\n`)
  if (!hasFlag(args, "--force")) {
    if (!(await promptYN("Delete? [y/N] "))) { console.log("Cancelled."); return }
  }
  console.log(deleteMemoryEvent(memKey, e.id) ? `\x1b[32mDeleted.${R}` : `\x1b[31mFailed to delete.${R}`)
}

// --- Edit ---
async function handleEdit(args: string[]): Promise<void> {
  const inlineContent = getFlag(args, "--content")
  const eventId = args.find((a) => !a.startsWith("--") && a !== inlineContent)
  if (!eventId) { console.error("Usage: ambient memories edit <event-id> [--content \"new content\"]"); process.exit(1) }
  const { memKey, match } = findEvent(eventId)
  if (!match) { console.error(`Event not found: ${eventId}`); process.exit(1) }

  let newContent: string
  if (inlineContent) {
    newContent = inlineContent
  } else {
    const editor = process.env["EDITOR"] ?? "vi"
    const tmpFile = join(mkdtempSync(join(tmpdir(), "ambient-edit-")), "memory.txt")
    writeFileSync(tmpFile, match.event.content)
    try {
      execFileSync(editor, [tmpFile], { stdio: "inherit" })
      newContent = readFileSync(tmpFile, "utf-8").trim()
    } finally { try { unlinkSync(tmpFile) } catch { /* ignore */ } }
    if (newContent === match.event.content) { console.log("No changes made."); return }
  }
  console.log(updateMemoryEvent(memKey, match.event.id, newContent) ? `\x1b[32mUpdated.${R}` : `\x1b[31mFailed to update.${R}`)
}

// --- Export ---
interface ExportFormat {
  version: number; exportedAt: string
  projects: Record<string, { project: ReturnType<typeof loadProjectMemory>; tasks: Record<string, ReturnType<typeof loadTaskMemory>> }>
}

function handleExport(args: string[]): void {
  const result: ExportFormat = { version: 1, exportedAt: new Date().toISOString(), projects: {} }
  for (const pk of listAllProjects()) {
    const project = loadProjectMemory(pk)
    if (!project) continue
    const tasks: Record<string, ReturnType<typeof loadTaskMemory>> = {}
    for (const tk of listTaskKeys(pk)) { const t = loadTaskMemory(pk, tk); if (t) tasks[tk] = t }
    result.projects[pk] = { project, tasks }
  }
  process.stdout.write((hasFlag(args, "--pretty") ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n")
}

// --- Import ---
function handleImport(args: string[]): void {
  const filePath = args.find((a) => !a.startsWith("--"))
  if (!filePath) { console.error("Usage: ambient memories import <file.json>"); process.exit(1) }
  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1) }

  let data: ExportFormat
  try { data = JSON.parse(readFileSync(filePath, "utf-8")) as ExportFormat }
  catch { console.error("Failed to parse import file."); process.exit(1) }
  if (data.version !== 1) { console.error(`Unsupported export version: ${data.version}`); process.exit(1) }

  let imported = 0, skipped = 0
  for (const entry of Object.values(data.projects)) {
    if (!entry.project) continue
    const p = entry.project
    const pIds = new Set((loadProjectMemory(p.projectKey)?.events ?? []).map((e) => e.id))
    for (const e of p.events) { if (pIds.has(e.id)) { skipped++ } else { addProjectEvent(p.projectKey, p.projectName, p.origin, e); imported++ } }
    for (const task of Object.values(entry.tasks)) {
      if (!task) continue
      const tIds = new Set((loadTaskMemory(task.projectKey, task.branchKey)?.events ?? []).map((e) => e.id))
      for (const e of task.events) { if (tIds.has(e.id)) { skipped++ } else { addTaskEvent(task.projectKey, task.branchKey, task.branchName, e); imported++ } }
    }
  }
  console.log(`\x1b[32mImport complete.${R} ${imported} imported, ${skipped} duplicates skipped.`)
}

// --- Stats ---
function handleStats(): void {
  let projects = 0, tasks = 0, total = 0, disk = 0, oldest = Infinity, newest = 0
  const byType: Record<string, number> = {}, byImp: Record<string, number> = {}

  const tally = (e: MemoryEvent) => {
    total++
    byType[e.type] = (byType[e.type] ?? 0) + 1
    byImp[e.importance] = (byImp[e.importance] ?? 0) + 1
    if (e.timestamp < oldest) oldest = e.timestamp
    if (e.timestamp > newest) newest = e.timestamp
  }

  for (const pk of listAllProjects()) {
    const proj = loadProjectMemory(pk)
    if (!proj) continue
    projects++
    const dir = getProjectDir(pk)
    try { disk += statSync(join(dir, "project.json")).size } catch { /* */ }
    for (const e of proj.events) tally(e)
    for (const tk of listTaskKeys(pk)) {
      tasks++
      const t = loadTaskMemory(pk, tk)
      if (!t) continue
      try { disk += statSync(join(dir, "tasks", `${tk}.json`)).size } catch { /* */ }
      for (const e of t.events) tally(e)
    }
  }

  const fmtDisk = disk < 1024 ? `${disk} B` : disk < 1048576 ? `${(disk / 1024).toFixed(1)} KB` : `${(disk / 1048576).toFixed(1)} MB`
  const fmtDate = (ts: number) => ts === Infinity || ts === 0 ? "n/a" : new Date(ts).toISOString().slice(0, 10)
  const pct = (n: number) => total > 0 ? `(${Math.round((n / total) * 100)}%)` : ""

  console.log(`\n${B}Memory Statistics${R}\n`)
  console.log(`  Projects: ${projects}    Tasks: ${tasks}    Total events: ${total}\n`)
  if (Object.keys(byType).length > 0) {
    console.log(`  ${B}By type:${R}`)
    for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1]))
      console.log(`    ${ct(t).padEnd(35)} ${String(c).padStart(4)}  ${D}${pct(c)}${R}`)
    console.log()
  }
  console.log(`  ${B}By importance:${R}`)
  for (const k of ["high", "medium", "low"] as const)
    console.log(`    ${ci(k).padEnd(25)} ${String(byImp[k] ?? 0).padStart(4)}  ${D}${pct(byImp[k] ?? 0)}${R}`)
  console.log(`\n  Disk:    ${fmtDisk}\n  Oldest:  ${fmtDate(oldest)}\n  Newest:  ${fmtDate(newest)}\n`)
}

// --- Helpers ---
function promptYN(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (a) => { rl.close(); resolve(a.toLowerCase() === "y" || a.toLowerCase() === "yes") })
  })
}

function printUsage(): void {
  console.log(`
${B}ambient memories${R} — browse and manage memory events

${B}Subcommands:${R}
  (none)                  List events (newest first, last 20)
  search <query>          Search across all projects (TF-IDF + recency)
  delete <event-id>       Delete an event (with confirmation)
  edit <event-id>         Edit in $EDITOR or inline with --content "x"
  export                  Export all memory to JSON (stdout)
  import <file.json>      Import from exported JSON
  stats                   Show aggregate statistics

${B}List flags:${R}  --all  --type <t>  --importance <i>  --since <spec>  --scope <s>  --json
${B}Search flags:${R}  --limit N  --json
${B}Delete flags:${R}  --force
${B}Export flags:${R}  --pretty`)
}
