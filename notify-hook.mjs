#!/usr/bin/env node
/**
 * Codex hook: surface finished dsh-subagent tasks into the Codex conversation.
 *
 * Codex runs this after a tool call (PostToolUse) and before it accepts a new user
 * prompt (UserPromptSubmit). It reads the task state mirror written by index.mjs,
 * reports every finished-but-unreported task once, and emits it as
 * hookSpecificOutput.additionalContext — the same channel context-mode uses.
 *
 * It never blocks and never fails the turn: any problem means "print nothing".
 *
 * Usage: node notify-hook.mjs <PostToolUse|UserPromptSubmit>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = join(HERE, 'state', 'tasks.json')
const event = process.argv[2] || 'PostToolUse'

// Drain and ignore the hook payload; only the shared state file matters.
try { readFileSync(0, 'utf8') } catch { /* no stdin */ }

let state
try { state = JSON.parse(readFileSync(STATE, 'utf8')) } catch { process.exit(0) }

const pending = Object.values(state.tasks || {}).filter(
  (t) => !t.notified && (t.state === 'completed' || t.state === 'failed'),
)
if (pending.length === 0) process.exit(0)

const MAX = 1500
const blocks = []
for (const t of pending) {
  t.notified = true
  if (t.state === 'completed') {
    const body = String(t.text || '').trim()
    const clipped = body.length > MAX
      ? `${body.slice(0, MAX)}\n…（已截断；完整内容用 subagent_dsh_status(task_id="${t.id}") 取回）`
      : body
    const secs = Math.round(((t.finishedAt || Date.now()) - (t.startedAt || Date.now())) / 1000)
    blocks.push(`[DSH 子任务完成] ${t.id} · ${t.sessionId || '无会话'} · ${secs}s · ${t.cwd}\n${clipped}`)
  } else {
    blocks.push(`[DSH 子任务失败] ${t.id} · ${t.error || '未知错误'}\n调 subagent_dsh_status(task_id="${t.id}") 看完整 stderr`)
  }
}

state.updatedAt = Date.now()
try { writeFileSync(STATE, JSON.stringify(state, null, 1)) } catch { /* best effort */ }

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: event, additionalContext: blocks.join('\n\n') },
})}\n`)
