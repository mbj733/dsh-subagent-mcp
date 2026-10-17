<p align="center">
  <img src="https://img.shields.io/badge/MCP-server-4D6BFE?style=flat-square" alt="MCP server">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522.19-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22.19+">
  <img src="https://img.shields.io/github/license/mbj733/dsh-subagent-mcp?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/github/stars/mbj733/dsh-subagent-mcp?style=flat-square" alt="stars">
</p>

# dsh-subagent-mcp

**Let Codex (or any MCP host) hand a task to a fresh DeepSeek Harness agent — with your
skills, your `AGENTS.md`, in the project directory you name — and get the answer back.**

One process, one turn, one answer. No daemon, no dependencies, no changes to your DSH profile.

```text
Codex / Claude Code / any MCP client
        │  MCP over stdio
        ▼
  dsh-subagent-mcp                        ← this package, ~600 lines, zero deps
        │  spawn: dsh --profile <p> --patch <overlay> --json
        ▼
  DeepSeek Harness (headless)
        │  inherits DSH_HOME → AGENTS.md, skills, sign-in
        ▼
  your project directory, one turn, final answer
```

## Why this exists

A DSH agent is one process with one context. When another agent needs DSH's skills,
filesystem access or long-running turns, driving it through a GUI costs a screen or DOM
round-trip per step. This bridge replaces that with one tool call.

Three design choices follow from that:

| Choice | Why it matters |
|---|---|
| **Stateless per call** | Every delegation is a new process and exactly one turn. Nothing to supervise, nothing to leak between tasks. |
| **Overlay, not profile surgery** | Configuration arrives as `dsh --patch` layers, so your existing profiles are never rewritten. |
| **Two explicit cost tiers** | `lite` ≈ 9k input tokens, `full` ≈ 300k. The caller picks, instead of discovering it on the bill. |

## Quick start

Requires Node.js ≥ 22.19 and a working `dsh` (the bundled dependency provides it).

```bash
git clone https://github.com/mbj733/dsh-subagent-mcp
cd dsh-subagent-mcp
npm install
```

Register it with your host — **Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.dsh_subagent]
command = 'node'
args = ['/absolute/path/to/dsh-subagent-mcp/index.mjs']
startup_timeout_sec = 30
```

Restart the host. On first use the server creates its own profile at
`$DSH_HOME/profiles/dsh-subagent` from the shipped headless template — it does not touch
`profiles/desktop` or any other profile you already have.

Then, in Codex:

> Delegate to DSH: summarise `src/` and list the files that look unused. Work in `/path/to/project`.

## Tools

| Tool | Overlay | What it does |
|---|---|---|
| `subagent_dsh` | lite | Delegate a task. Skills, shell, file editing, web search — no MCP tools. ≈9k input tokens. |
| `subagent_dsh_full` | full | Same, plus the MCP servers declared in `overlay.yml`. ≈300k input tokens with a dozen servers. |
| `subagent_dsh_status` | — | Collect a task. Accepts a task id (`t-…`) **or** a dsh session id. |
| `subagent_dsh_continue` | — | Follow-up in the same dsh session; `cwd`/`overlay` default to the remembered values. |
| `subagent_dsh_cancel` | — | Kill a running or queued task and its whole process tree. |

| Argument | Default | Meaning |
|---|---|---|
| `prompt` | — | Required. The child cannot see the host conversation — include everything it needs. |
| `cwd` | — | Required. Absolute project directory. **Not a sandbox** (see Security). |
| `wait_sec` | 120 | Wait before returning a task id. `0` returns immediately. |
| `timeout_sec` | 1800 | Hard limit; on expiry the process tree is killed and partial output is returned. |
| `read_only` | false | Ask the child to make no filesystem changes (instruction + detection, not a kernel sandbox). |
| `format` | text | `json` returns `{ok, state, answer, usage, meta}` for programmatic use. |

Long tasks are safe by design: the call waits `wait_sec`, then hands back a task id, so a
host-side tool timeout can never kill the work.

## Cost and capability, measured

| Overlay | Mounts | Typical input tokens | Use it for |
|---|---|---|---|
| `lite` | credentials + skills | **~9,000** | writing, refactoring, analysis, anything done with shell + files |
| `full` | + 11 MCP servers | **~300,000** | tasks that genuinely need PDF/office/browser/GitHub/map tools |

A short `lite` reply, measured end to end: `startup 1.67s · work 1.19s · tokens in 9073 / out 2`.

## Optional: report finished tasks back into the host

MCP has no channel for a late result, so long tasks return a task id. On hosts with hooks you
can close that gap: `notify-hook.mjs` injects any finished task into the next turn.

```toml
# Codex. `type = "command"` is mandatory — a missing type breaks the whole config file.
[[hooks.PostToolUse]]

[[hooks.PostToolUse.hooks]]
type = "command"
command = "'node' '/absolute/path/to/dsh-subagent-mcp/notify-hook.mjs' PostToolUse"
timeout = 5
```

It reads `state/tasks.json`, reports each finished task exactly once, and stays silent otherwise.

## Operational details

- **Bounded concurrency** — `DSH_SUBAGENT_MAX_CONCURRENCY` (default 2) with a FIFO queue;
  extra calls return `queued` plus their position.
- **Usage reporting** — token counts, tool calls and names, `startup_ms` / `work_ms`,
  `exit_code`, `error_code` (`TIMEOUT`, `CANCELLED`, `SPAWN_FAILED`, `EMPTY_ANSWER`,
  `CHILD_EXIT`, `RATE_LIMIT`).
- **Oversized answers** — above `DSH_SUBAGENT_INLINE_LIMIT` (default 24000 chars) the full text
  spills to `state/results/<task>.md`; the reply states the percentage shown.
- **No orphans** — cancellation and shutdown use process-tree kill (`taskkill /T /F` on Windows).

## Security

- **`cwd` is not a sandbox.** It selects the working directory only; the child inherits the
  host user's filesystem and network rights.
- **`read_only` is advisory.** Enforced by instruction and reported by detection, not by the kernel.
- The child inherits `DSH_HOME`, so it reads your `AGENTS.md`, skills and stored credentials.
- No third-party service is contacted beyond the model provider you configured.

## How this differs from a persistent-agent bridge

This bridge is deliberately **stateless**: a process per task, one turn, then exit. That keeps
the failure surface small and the billing predictable, but it means:

- no daemon, no background queue beyond the in-process FIFO;
- no native "wake the parent when done" callback — that needs host hooks (see above);
- no way to attach to a DSH session that is already running elsewhere.

If your workflow needs a resident daemon with native completion callbacks and session attach,
that is a different design with a different footprint.

## Limitations

- One turn per call; no streaming and no mid-run questions. Use `subagent_dsh_continue` for follow-ups.
- The host sees only the final answer, never the child's conversation.
- Several host windows each run their own server instance and share `state/tasks.json`, so hook
  notifications can duplicate.

## Built on

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the reverse of
[`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex),
which lets DSH drive a Codex thread. This is the other direction.

## Author

Built and maintained by [@mbj733](https://github.com/mbj733).

## License

MIT.
