#!/usr/bin/env node
/**
 * dsh-subagent-mcp v0.5 — expose DeepSeek Harness as a subagent to any MCP host.
 *
 * Reverse of @deepseek-ai/dsh-subagent-codex: that lets a DSH agent drive a fresh
 * Codex thread; this lets an MCP host drive a fresh DSH one-shot run.
 *
 * Two delegate tools instead of one knob:
 *   subagent_dsh       -> lite overlay (credentials + skills, no MCP servers)
 *   subagent_dsh_full  -> full overlay (adds the 11 MCP servers, ~20x prompt)
 *
 * Per-call: wait_sec, timeout_sec, read_only (advisory), format (text|json).
 * Results report usage, tool calls, exit code, error code, startup/work split.
 *
 * Honest boundaries:
 *   - `cwd` only selects the working directory; it is NOT a sandbox. The child
 *     inherits the host user's filesystem rights.
 *   - `read_only` is enforced by instruction + detection, not by a kernel sandbox.
 *
 * No third-party dependencies: minimal newline-delimited JSON-RPC 2.0.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const DSH_BIN = join(HERE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = process.env.DSH_SUBAGENT_PROFILE || 'dsh-subagent'
const OVERLAYS = { lite: join(HERE, 'overlay.lite.yml'), full: join(HERE, 'overlay.yml') }
const DEFAULT_TIMEOUT_SEC = Number(process.env.DSH_SUBAGENT_TIMEOUT_SEC || 1800)
const MAX_TIMEOUT_SEC = Number(process.env.DSH_SUBAGENT_MAX_TIMEOUT_SEC || 7200)
const DEFAULT_WAIT_SEC = Number(process.env.DSH_SUBAGENT_WAIT_SEC || 120)
const MAX_CONCURRENT = Math.max(1, Number(process.env.DSH_SUBAGENT_MAX_CONCURRENCY || 2))
const INLINE_LIMIT = Number(process.env.DSH_SUBAGENT_INLINE_LIMIT || 24000)
const MAX_TAIL = 4000
const STATE_DIR = join(HERE, 'state')
const STATE_FILE = join(STATE_DIR, 'tasks.json')
const RESULTS_DIR = join(STATE_DIR, 'results')

const SERVER_INFO = { name: 'dsh-subagent-mcp', version: '0.5.0' }
const PROTOCOL_FALLBACK = '2025-06-18'

const WRITE_TOOL_RE = /^(write|edit|apply_patch|str_replace|multi_edit|create|delete|move|rename)/i

const log = (...a) => process.stderr.write(`[dsh-subagent-mcp] ${a.join(' ')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tasks = new Map()
const inflight = new Map()
const sessions = new Map()

for (const [sid, meta] of Object.entries(loadState().sessions ?? {})) sessions.set(sid, meta)

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function persist() {
  const out = { version: 4, updatedAt: Date.now(), tasks: {}, sessions: {} }
  for (const [id, r] of tasks) {
    out.tasks[id] = {
      id, state: r.state, sessionId: r.sessionId, startedAt: r.startedAt, finishedAt: r.finishedAt,
      cwd: r.cwd, overlay: r.overlay, notified: r.notified === true, error: r.error,
      errorCode: r.errorCode, exitCode: r.exitCode, usage: r.usage, toolCalls: r.toolCalls,
      toolNames: r.toolNames.slice(0, 40), readOnly: r.readOnly,
      text: r.text && r.text.length > 4000 ? `${r.text.slice(0, 4000)}\n…(truncated in state)` : r.text,
      spillPath: r.spillPath || null,
    }
  }
  for (const [sid, meta] of sessions) out.sessions[sid] = meta
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(out, null, 1))
  } catch { /* never break a run */ }
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill('SIGKILL')
  } catch {
    try { child.kill() } catch { /* gone */ }
  }
}

function checkWorkspace(cwd) {
  if (cwd === undefined || cwd === null || String(cwd).trim() === '') {
    return { error: 'cwd is required: pass the absolute path of the project directory the subagent should work in.' }
  }
  const raw = String(cwd).trim()
  if (!isAbsolute(raw)) return { error: `cwd must be absolute, got "${raw}".` }
  const abs = resolve(raw)
  if (!existsSync(abs)) return { error: `cwd does not exist: ${abs}.` }
  try {
    if (!statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${abs}` }
  } catch {
    return { error: `cwd is not readable: ${abs}` }
  }
  const probe = join(abs, `.dsh-subagent-write-probe-${process.pid}`)
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
  } catch {
    return { error: `cwd is not writable by the MCP server: ${abs}` }
  }
  return { path: abs }
}

// ------------------------------------------------------------------ scheduling

let running = 0
const queue = []

async function acquireSlot(record) {
  if (running < MAX_CONCURRENT) { running++; return { waitedMs: 0 } }
  record.state = 'queued'
  record.queuePosition = queue.length + 1
  persist()
  const startedQueue = Date.now()
  await new Promise((res) => queue.push(res))
  record.state = 'running'
  return { waitedMs: Date.now() - startedQueue, position: 1 }
}

function releaseSlot() {
  const next = queue.shift()
  if (next) next()
  else running = Math.max(0, running - 1)
}

// ------------------------------------------------------------------ profile health

const PROFILE_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

/**
 * Third-party dsh plugins sometimes append their own block to every profile's
 * `cordis.patch.yml`. That file starts with a `[]` placeholder, so the append
 * makes the whole document invalid YAML and every spawn dies with
 * "failed to parse overlay". Detect that exact shape, keep a backup and put the
 * clean template back, instead of failing the user's task.
 */
function healProfilePatch() {
  const file = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const empty = lines.findIndex((line) => line.trim() === '[]')
  if (empty < 0) return null
  const trailing = lines.slice(empty + 1).filter((line) => {
    const t = line.trim()
    return t !== '' && !t.startsWith('#')
  })
  if (trailing.length === 0) return null

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-mcp-${stamp}`
  try {
    copyFileSync(file, backup)
    writeFileSync(file, PROFILE_TEMPLATE, 'utf8')
  } catch (err) {
    log(`could not heal profile patch: ${err.message}`)
    return null
  }
  log(`profile patch was invalid (block after []); reset, backup at ${backup}`)
  return backup
}

// ------------------------------------------------------------------ run

function startRun({ prompt, cwd, sessionId, overlay, timeoutSec, readOnly }) {
  const id = `t-${randomUUID().slice(0, 8)}`
  const record = {
    id, state: 'queued', text: null, partial: '', error: null, errorCode: null, exitCode: null,
    sessionId: sessionId || null, tail: '', startedAt: Date.now(), spawnedAt: null, firstEventAt: null,
    finishedAt: null, cwd, overlay: overlay || 'lite',
    timeoutMs: Math.min(Math.max(1, Number(timeoutSec || DEFAULT_TIMEOUT_SEC)), MAX_TIMEOUT_SEC) * 1000,
    usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
    toolCalls: 0, toolNames: [], phase: 'queued', readOnly: Boolean(readOnly),
    child: null, notified: false, spillPath: null, queuedMs: 0, queuePosition: null,
  }
  tasks.set(id, record)
  persist()

  const effectivePrompt = readOnly
    ? `【只读任务】不得创建、修改、删除或重命名任何文件；只允许读取、分析与计算。\n\n${prompt}`
    : prompt

  void (async () => {
    const { waitedMs } = await acquireSlot(record)
    record.queuedMs = waitedMs

    const profileDir = join(DSH_HOME, 'profiles', PROFILE)
    const profileReset = existsSync(profileDir) ? healProfilePatch() : null
    if (profileReset) record.profileReset = profileReset
    const args = [DSH_BIN, '--profile', PROFILE]
    if (!existsSync(profileDir)) args.push('--from-default-profile', 'headless')

    const overlayPath = OVERLAYS[record.overlay] || OVERLAYS.lite
    if (overlayPath && existsSync(overlayPath)) args.push('--patch', overlayPath)

    args.push('--json')
    if (sessionId) args.push('--session-id', sessionId)
    args.push('-')

    record.state = 'running'
    record.phase = 'starting'
    record.spawnedAt = Date.now()
    const child = spawn(NODE, args, {
      cwd, env: { ...process.env, DSH_HOME }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    record.child = child
    persist()

    let stdoutBuf = ''
    const finish = (state, detail) => {
      if (['completed', 'failed', 'cancelled'].includes(record.state)) return
      record.state = state
      record.finishedAt = Date.now()
      if (detail?.text !== undefined) record.text = detail.text
      if (detail?.error) record.error = detail.error
      if (detail?.errorCode) record.errorCode = detail.errorCode
      if (detail?.sessionId) record.sessionId = detail.sessionId
      record.child = null
      if (record.sessionId) {
        sessions.set(record.sessionId, { cwd: record.cwd, overlay: record.overlay, lastTaskId: record.id })
      }
      persist()
      releaseSlot()
      log(`task ${id} ${state}${record.sessionId ? ` session=${record.sessionId}` : ''}`)
    }

    const killer = setTimeout(() => {
      killTree(child)
      finish('failed', {
        error: `timed out after ${Math.round(record.timeoutMs / 1000)}s`,
        errorCode: 'TIMEOUT',
        text: record.partial.trim() || record.text || null,
      })
    }, record.timeoutMs)
    killer.unref?.()

    child.on('error', (err) => {
      clearTimeout(killer)
      finish('failed', { error: `failed to spawn dsh: ${err.message}`, errorCode: 'SPAWN_FAILED' })
    })

    const noteEvent = () => { if (!record.firstEventAt) record.firstEventAt = Date.now() }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line.startsWith('{')) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        noteEvent()
        if (ev.type === 'session' && ev.sessionId) record.sessionId = ev.sessionId
        else if (ev.type === 'final' && typeof ev.text === 'string') record.text = ev.text
        else if (ev.type === 'text' && typeof ev.text === 'string') { if (!record.text) record.partial += ev.text }
        else if (ev.type === 'error') {
          record.error = ev.message || 'dsh reported an error'
          record.errorCode = 'DSH_ERROR'
        } else if (ev.type === 'tool_call' || ev.type === 'toolCall') {
          record.toolCalls += 1
          const nm = ev.name || ev.tool || ev.toolName
          if (typeof nm === 'string') record.toolNames.push(nm)
          record.phase = `tool:${typeof nm === 'string' ? nm : 'unknown'}`
        } else if (ev.type === 'status' && typeof ev.phase === 'string') {
          record.phase = ev.phase
          if (ev.phase === 'step_end' && ev.usage) {
            record.usage.input += ev.usage.inputTokens || 0
            record.usage.output += ev.usage.outputTokens || 0
            record.usage.cacheRead += ev.usage.cacheReadTokens || 0
            record.usage.total += ev.usage.totalTokens || 0
          }
        }
      }
    })

    child.stderr.on('data', (chunk) => { record.tail = (record.tail + chunk.toString()).slice(-MAX_TAIL) })

    child.on('close', (code) => {
      clearTimeout(killer)
      record.exitCode = code
      if (record.text && record.text.trim() !== '') finish('completed')
      else if (record.text !== null) finish('failed', { error: 'the run finished without an answer', errorCode: 'EMPTY_ANSWER' })
      else finish('failed', {
        error: record.error || `dsh exited with code ${code}`,
        errorCode: record.errorCode || (/429|rate limit/i.test(record.tail) ? 'RATE_LIMIT' : 'CHILD_EXIT'),
      })
    })

    child.stdin.on('error', () => {})
    child.stdin.write(effectivePrompt.endsWith('\n') ? effectivePrompt : `${effectivePrompt}\n`)
    child.stdin.end()
  })()

  return record
}

async function waitFor(record, waitSec, progress) {
  const deadline = Date.now() + Math.max(0, Number(waitSec ?? DEFAULT_WAIT_SEC)) * 1000
  while ((record.state === 'running' || record.state === 'queued') && Date.now() < deadline) {
    await sleep(500)
    progress?.()
  }
  return record
}

function inlineText(record) {
  const body = String(record.text ?? '').trim()
  if (body.length <= INLINE_LIMIT) return body
  try {
    mkdirSync(RESULTS_DIR, { recursive: true })
    const path = join(RESULTS_DIR, `${record.id}.md`)
    writeFileSync(path, body, 'utf8')
    record.spillPath = path
    persist()
    const pct = Math.round((INLINE_LIMIT / body.length) * 100)
    return `${body.slice(0, INLINE_LIMIT)}\n\n…【已截断】只显示了 ${pct}%（${INLINE_LIMIT}/${body.length} 字符）。全文：${path}\n取回完整内容：subagent_dsh_status(task_id="${record.id}")`
  } catch {
    return `${body.slice(0, INLINE_LIMIT)}\n\n…【已截断】只显示了 ${Math.round((INLINE_LIMIT / body.length) * 100)}%（${INLINE_LIMIT}/${body.length} 字符）`
  }
}

function writeWarnings(record) {
  if (!record.readOnly) return []
  const hits = record.toolNames.filter((n) => WRITE_TOOL_RE.test(n))
  return hits.length ? [`⚠ read_only 任务里出现了写类工具调用：${[...new Set(hits)].join(', ')}（指令约束，非内核沙箱）`] : []
}

function meta(record) {
  const now = record.finishedAt || Date.now()
  const startupMs = record.firstEventAt && record.spawnedAt ? record.firstEventAt - record.spawnedAt : null
  const workMs = record.firstEventAt ? now - record.firstEventAt : null
  return {
    task_id: record.id,
    session_id: record.sessionId,
    state: record.state,
    phase: record.phase,
    overlay: record.overlay,
    cwd: record.cwd,
    read_only: record.readOnly,
    elapsed_ms: now - record.startedAt,
    queued_ms: Math.round(record.queuedMs),
    startup_ms: startupMs,
    work_ms: workMs,
    exit_code: record.exitCode,
    error_code: record.errorCode,
    tool_calls: record.toolCalls,
    tool_names: [...new Set(record.toolNames)].slice(0, 40),
    usage: record.usage,
    spill_path: record.spillPath,
  }
}

function footer(record) {
  const m = meta(record)
  const u = m.usage
  return [
    `task ${m.task_id}`,
    m.session_id ? `session ${m.session_id}` : null,
    `${(m.elapsed_ms / 1000).toFixed(0)}s`,
    m.queued_ms ? `queued ${(m.queued_ms / 1000).toFixed(0)}s` : null,
    m.startup_ms !== null ? `startup ${(m.startup_ms / 1000).toFixed(1)}s` : null,
    m.work_ms !== null ? `work ${(m.work_ms / 1000).toFixed(1)}s` : null,
    `cwd ${m.cwd}`,
    `overlay ${m.overlay}${m.read_only ? ' · read_only' : ''}`,
    `tools ${m.tool_calls}`,
    `tokens in ${u.input} / out ${u.output}${u.cacheRead ? ` / cache ${u.cacheRead}` : ''}`,
    m.exit_code !== null ? `exit ${m.exit_code}` : null,
    m.error_code ? `error ${m.error_code}` : null,
    record.profileReset ? 'profile-patch auto-reset' : null,
  ].filter(Boolean).join(' · ')
}

function render(record, format) {
  if (format === 'json') {
    return JSON.stringify({
      ...meta(record),
      ok: record.state === 'completed',
      answer: record.state === 'completed' ? String(record.text ?? '') : null,
      error: record.error,
      warnings: writeWarnings(record),
    }, null, 2)
  }
  if (record.state === 'queued') {
    return `DSH subagent is queued (task ${record.id}, position ${record.queuePosition ?? '?'}, max ${MAX_CONCURRENT} concurrent). Poll subagent_dsh_status(task_id="${record.id}").`
  }
  if (record.state === 'running') {
    return [
      `DSH subagent is still running (task ${record.id}, ${((Date.now() - record.startedAt) / 1000).toFixed(0)}s, phase ${record.phase}, cwd ${record.cwd}).`,
      `Collect it with subagent_dsh_status(task_id="${record.id}"); stop it with subagent_dsh_cancel.`,
      record.sessionId ? `dsh session: ${record.sessionId}` : null,
    ].filter(Boolean).join('\n')
  }
  if (record.state === 'completed') {
    return [inlineText(record), '', '---', footer(record), 'Pass the session id to subagent_dsh_continue to keep the conversation.'].join('\n')
  }
  if (record.state === 'cancelled') {
    return `DSH subagent task ${record.id} was cancelled (${record.error || 'stopped by the caller'}).\n${footer(record)}`
  }
  const partial = String(record.text ?? '').trim()
  const brokenProfile = /\bfailed to parse overlay\b|YAMLException/i.test(`${record.error ?? ''}\n${record.tail ?? ''}`)
  return [
    `DSH subagent failed: ${record.error}`,
    record.exitCode !== null ? `exit code: ${record.exitCode}` : null,
    brokenProfile
      ? [
          '',
          '💡 这个错误是 dsh profile 的补丁文件坏了（`cordis.patch.yml` 以 `[]` 开头，后面又被追加了块，整份 YAML 解析失败）。',
          `   修复：node ${join(HERE, 'repair-profile.mjs')}`,
          '   它会把当前文件自动备份成 `.bak-<时间戳>`，再写回干净的模板。',
        ].join('\n')
      : null,
    partial ? `\n部分输出（失败前已产生）:\n${partial}` : null,
    footer(record),
    record.tail ? `\nstderr (tail):\n${record.tail}` : null,
  ].filter(Boolean).join('\n')
}

// ------------------------------------------------------------------ tools

const CWD_PROP = {
  type: 'string',
  description:
    'Absolute path of the project directory the child works in. Must exist, be a directory and be writable. ' +
    'NOTE: cwd only selects the working directory — it is NOT a sandbox boundary; the child inherits the host user\'s filesystem rights.',
}
const TIMEOUT_PROP = {
  type: 'number',
  description: `Hard limit in seconds (default ${DEFAULT_TIMEOUT_SEC}, cap ${MAX_TIMEOUT_SEC}). On expiry the whole process tree is killed and any partial answer is returned.`,
}
const WAIT_PROP = { type: 'number', description: 'Seconds to wait before returning a task id. Default 120. Use 0 to return immediately.' }
const READONLY_PROP = { type: 'boolean', description: 'Ask the child to make no filesystem changes. Enforced by instruction and reported by detection — not a kernel sandbox.' }
const FORMAT_PROP = { type: 'string', enum: ['text', 'json'], description: 'text (default): human-readable. json: machine-readable envelope with answer, usage, meta.' }

function delegateTool(name, overlay) {
  const isFull = overlay === 'full'
  return {
    name,
    description:
      `Delegate one self-contained task to a brand-new DeepSeek Harness (dsh) agent and return its final answer. ` +
      `Overlay: **${overlay}** — ${isFull
        ? 'credentials + skills + the 11 MCP servers (PDF/office/docling/browser/github/firecrawl/amap/codebase-memory/rea/context-mode). Prompt cost ≈300k input tokens per run, so use it only when the task needs those tools.'
        : 'credentials + skills + shell + file editing + web search, but NO MCP tools (no PDF/office/docling/browser/github/amap). Cheap (~9k tokens). Use subagent_dsh_full when those are needed.'} ` +
      `The child cannot see this conversation and cannot ask questions, so the prompt must be self-contained. ` +
      `Default preset: model id \`deepseek-flash\` (shown as DeepSeek-V4.1-Flash in the DSH UI) at reasoning effort **max**; ` +
      `set DSH_SUBAGENT_MODEL on the server to change it. ` +
      `cwd is REQUIRED and only selects the working directory (it is not a sandbox). ` +
      `Returns the answer, or a task id when still running after wait_sec (then poll subagent_dsh_status).`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete task. Include every constraint and input; the child cannot see this conversation.' },
        cwd: CWD_PROP,
        wait_sec: WAIT_PROP,
        timeout_sec: TIMEOUT_PROP,
        read_only: READONLY_PROP,
        format: FORMAT_PROP,
      },
      required: ['prompt', 'cwd'],
      additionalProperties: false,
    },
  }
}

const TOOLS = [
  delegateTool('subagent_dsh', 'lite'),
  delegateTool('subagent_dsh_full', 'full'),
  {
    name: 'subagent_dsh_status',
    description:
      'Collect a DSH subagent task, or wait for it. Accepts a task id (t-xxxxxxxx) or the dsh session id. Safe to call repeatedly; reports phase, usage, tool names and error code.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id (t-…) or dsh session id returned by a delegate tool.' },
        wait_sec: { type: 'number', description: 'Extra seconds to wait for completion. Default 0.' },
        format: FORMAT_PROP,
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'subagent_dsh_continue',
    description:
      'Continue a dsh session started by a delegate tool, preserving its history. ' +
      'cwd and overlay are optional: omitted values are taken from the remembered session. ' +
      'If dsh rejects the session because the working directory differs, pass the original cwd explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'dsh session id reported by a delegate tool.' },
        prompt: { type: 'string', description: 'The follow-up task.' },
        cwd: { type: 'string', description: 'Optional. Defaults to the cwd remembered for this session.' },
        overlay: { type: 'string', enum: ['lite', 'full'], description: 'Optional. Defaults to the overlay remembered for this session.' },
        wait_sec: WAIT_PROP,
        timeout_sec: TIMEOUT_PROP,
        read_only: READONLY_PROP,
        format: FORMAT_PROP,
      },
      required: ['session_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'subagent_dsh_cancel',
    description: 'Stop a running (or queued) DSH subagent task and its whole process tree.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id returned by a delegate tool.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
]

function findRecord(idOrSession) {
  const key = String(idOrSession ?? '')
  if (tasks.has(key)) return tasks.get(key)
  for (const r of tasks.values()) if (r.sessionId === key) return r
  return null
}

async function callTool(name, args, requestId, sendProgress) {
  const format = args.format === 'json' ? 'json' : 'text'

  if (name === 'subagent_dsh' || name === 'subagent_dsh_full' || name === 'subagent_dsh_continue') {
    const isContinue = name === 'subagent_dsh_continue'
    const prompt = String(args.prompt ?? '').trim()
    if (!prompt) return { isError: true, text: 'prompt must be a non-empty string.' }

    let sessionId
    let cwd = args.cwd
    let overlay = args.overlay ?? (name === 'subagent_dsh_full' ? 'full' : name === 'subagent_dsh' ? 'lite' : undefined)
    if (isContinue) {
      sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { isError: true, text: 'session_id is required for subagent_dsh_continue.' }
      const remembered = sessions.get(sessionId)
      if (!cwd && remembered?.cwd) cwd = remembered.cwd
      if (!overlay && remembered?.overlay) overlay = remembered.overlay
      if (!cwd) return { isError: true, text: `no cwd known for session ${sessionId}; pass cwd explicitly (it must match the original run).` }
    }

    const ws = checkWorkspace(cwd)
    if (ws.error) return { isError: true, text: ws.error }

    const record = startRun({
      prompt, cwd: ws.path, sessionId, overlay,
      timeoutSec: args.timeout_sec, readOnly: args.read_only,
    })
    if (requestId !== undefined) inflight.set(String(requestId), record.id)

    await waitFor(record, args.wait_sec, sendProgress)
    if (requestId !== undefined) inflight.delete(String(requestId))
    return { isError: record.state === 'failed', text: render(record, format) }
  }

  if (name === 'subagent_dsh_status') {
    const record = findRecord(args.task_id)
    if (!record) {
      return { isError: true, text: `unknown task/session id: ${args.task_id}. Only tasks from this server instance are visible; after a Codex restart, pass the dsh session id to subagent_dsh_continue.` }
    }
    await waitFor(record, args.wait_sec ?? 0, sendProgress)
    return { isError: record.state === 'failed', text: render(record, format) }
  }

  if (name === 'subagent_dsh_cancel') {
    const record = findRecord(args.task_id)
    if (!record) return { isError: true, text: `unknown task id: ${args.task_id}` }
    if (record.state !== 'running' && record.state !== 'queued') {
      return { isError: false, text: `task ${record.id} already ${record.state}.` }
    }
    if (record.child) killTree(record.child)
    record.state = 'cancelled'
    record.finishedAt = Date.now()
    record.error = 'cancelled by the caller'
    record.errorCode = 'CANCELLED'
    record.child = null
    releaseSlot()
    persist()
    return { isError: false, text: `task ${record.id} cancelled.\n${footer(record)}` }
  }

  throw new Error(`unknown tool: ${name}`)
}

// ---------------------------------------------------------------- JSON-RPC

const send = (message) => {
  try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch { /* host gone */ }
}
process.stdout.on('error', () => {})

async function handleRequest(msg) {
  const { id, method, params } = msg
  const progressToken = params?._meta?.progressToken
  const sendProgress = progressToken === undefined ? undefined : (() => {
    const started = Date.now()
    let last = 0
    return () => {
      const now = Date.now()
      if (now - last < 5000) return
      last = now
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: Math.round((now - started) / 1000), message: 'dsh subagent working' } })
    }
  })()

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_FALLBACK,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Runs a fresh DeepSeek Harness agent per call. Choose subagent_dsh (lite, cheap) or subagent_dsh_full (adds MCP tools, ~20x prompt). ' +
            `Always pass an absolute cwd; it selects the working directory only (not a sandbox). At most ${MAX_CONCURRENT} run concurrently; extras queue.`,
        },
      })
      return
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return }
    if (method === 'tools/call') {
      const { isError, text } = await callTool(params?.name, params?.arguments ?? {}, id, sendProgress)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: Boolean(isError) } })
      return
    }
    if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: [] } }); return }
    if (method === 'resources/list') { send({ jsonrpc: '2.0', id, result: { resources: [] } }); return }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message ?? String(err) } })
  }
}

function handleCancelled(params) {
  const requestId = params?.requestId
  if (requestId === undefined) return
  const taskId = inflight.get(String(requestId))
  if (!taskId) return
  const record = tasks.get(taskId)
  if (record && (record.state === 'running' || record.state === 'queued')) {
    if (record.child) killTree(record.child)
    record.state = 'cancelled'
    record.finishedAt = Date.now()
    record.error = 'cancelled by the host'
    record.errorCode = 'CANCELLED'
    record.child = null
    releaseSlot()
    persist()
    log(`task ${taskId} cancelled by host (request ${requestId})`)
  }
  inflight.delete(String(requestId))
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'notifications/cancelled' || msg.method === '$/cancelRequest') handleCancelled(msg.params)
    return
  }
  void handleRequest(msg)
})

rl.on('close', () => {
  for (const record of tasks.values()) if (record.child) killTree(record.child)
  process.exit(0)
})

log(`ready v${SERVER_INFO.version} (dsh ${existsSync(DSH_BIN) ? 'found' : 'MISSING'}, home ${DSH_HOME}, maxConcurrent ${MAX_CONCURRENT}, timeout ${DEFAULT_TIMEOUT_SEC}s)`)
