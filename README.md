<p align="center">
  <img src="https://img.shields.io/badge/MCP-server-4D6BFE?style=flat-square" alt="MCP server">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522.19-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22.19+">
  <img src="https://img.shields.io/github/license/mbj733/dsh-subagent-mcp?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/github/stars/mbj733/dsh-subagent-mcp?style=flat-square" alt="stars">
</p>

# dsh-subagent-mcp

**Let Codex — or any MCP host — hand a task to a fresh DeepSeek Harness agent that already has
your skills, your `AGENTS.md` and your sign-in, working in the project directory you name.**

One process, one turn, one answer. No daemon, no runtime dependencies, no edits to your DSH profile.

```text
Codex / Claude Code / any MCP client
        │  MCP over stdio
        ▼
  dsh-subagent-mcp                     ← ~600 lines, zero dependencies
        │  spawn: dsh --profile <p> --patch <overlay> --json
        ▼
  DeepSeek Harness (headless)          ← inherits DSH_HOME: AGENTS.md, skills, sign-in
        ▼
  your project directory · one turn · final answer
```

- **Default preset:** DeepSeek-V4.1-Flash (id `deepseek-flash`) at reasoning effort `max`.
- **Nothing to configure:** the first call creates its own `dsh-subagent` profile from the shipped
  headless template.

## Install

Requires Node.js ≥ 22.19. The bundled dependency provides the `dsh` CLI.

**A · straight from GitHub** — no clone, no build, no npm account:

```toml
# ~/.codex/config.toml
[mcp_servers.dsh_subagent]
command = 'npx'
args = ['-y', 'github:mbj733/dsh-subagent-mcp']
startup_timeout_sec = 60
```

**B · pinned tarball**

```bash
npm i -g https://github.com/mbj733/dsh-subagent-mcp/releases/download/v0.5.0/mbj733-dsh-subagent-mcp-0.5.0.tgz
```

**C · clone** (when you want to read or patch the code)

```bash
git clone https://github.com/mbj733/dsh-subagent-mcp
cd dsh-subagent-mcp && npm install
```

```toml
[mcp_servers.dsh_subagent]
command = 'node'
args = ['/absolute/path/to/dsh-subagent-mcp/index.mjs']
startup_timeout_sec = 30
```

Restart the host afterwards. Then just ask:

> Delegate to DSH: summarise `src/` and list the files that look unused. Work in `/path/to/project`.

## Tools

| Tool | Overlay | What it does |
|---|---|---|
| `subagent_dsh` | lite | Delegate a task: skills, shell, file editing, web search — no MCP tools. ≈9k input tokens. |
| `subagent_dsh_full` | full | Same, plus every MCP server declared in `overlay.yml`. ≈300k input tokens with a dozen servers. |
| `subagent_dsh_status` | — | Collect a task. Accepts a task id (`t-…`) **or** a dsh session id. |
| `subagent_dsh_continue` | — | Follow-up in the same dsh session; `cwd`/`overlay` default to the remembered values. |
| `subagent_dsh_cancel` | — | Kill a running or queued task and its whole process tree. |

| Argument | Default | Meaning |
|---|---|---|
| `prompt` | — | Required. The child cannot see the host conversation — include everything it needs. |
| `cwd` | — | Required. Absolute project directory. **Not a sandbox** (see Security). |
| `wait_sec` | 120 | Wait before returning a task id. `0` returns immediately. |
| `timeout_sec` | 1800 | Hard limit; on expiry the tree is killed and partial output returned. |
| `read_only` | false | Ask the child to make no filesystem changes (instruction + detection, not a kernel sandbox). |
| `format` | text | `json` returns `{ok, state, answer, usage, meta}`. |

Long tasks are safe by design: the call waits `wait_sec`, then returns a task id, so a host-side
tool timeout can never kill the work.

## Model and cost

The child runs **DeepSeek-V4.1-Flash** — model id `deepseek-flash` — at reasoning effort **max**.
That is what both overlays ship; verify it yourself:

```bash
dsh --profile dsh-subagent --patch overlay.lite.yml --dump-config | grep -A4 agent-default-model
```

The account line exposes two ids (checked against `GET https://api.deepseek.com/models`):

| id | displayed as |
|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash · **default** |
| `deepseek-v4-pro` | DeepSeek-V4-Pro |

Switch per machine without editing files: `export DSH_SUBAGENT_MODEL=deepseek-v4-pro`.

> Pin the **id**, not the label. Provider-specific ids from other lines — for example opencode's
> `deepseek-v4.1-flash` — are not valid here; they need that provider's key and `base_url` on the
> `dsh-subagent` profile.

| Overlay | Mounts | Typical input tokens | Use it for |
|---|---|---|---|
| `lite` | credentials + skills | **~9,000** | writing, refactoring, analysis — anything done with shell and files |
| `full` | + 11 MCP servers | **~300,000** | tasks that genuinely need PDF/office/browser/GitHub/map tools |

A short `lite` reply, measured end to end: `startup 1.67s · work 1.19s · tokens in 9073 / out 2`.

## Verify an install without a host

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npx -y github:mbj733/dsh-subagent-mcp
```

Expect `serverInfo.name = dsh-subagent-mcp` and exactly five tools.

**Installing this for someone else, or as an agent?** Read [`llms.txt`](llms.txt) for the
machine-readable guide and [`AGENTS.md`](AGENTS.md) for registration rules and repository
conventions. Generic client config:

```json
{"mcpServers":{"dsh_subagent":{"command":"npx","args":["-y","github:mbj733/dsh-subagent-mcp"]}}}
```

## Optional: report finished tasks back into the host

MCP has no channel for a late result, so long tasks return a task id. On hosts with hooks,
`notify-hook.mjs` injects any finished task into the next turn.

```toml
# Codex. `type = "command"` is mandatory — a missing type breaks the whole config file.
[[hooks.PostToolUse]]

[[hooks.PostToolUse.hooks]]
type = "command"
command = "'node' '/absolute/path/to/dsh-subagent-mcp/notify-hook.mjs' PostToolUse"
timeout = 5
```

It reads `state/tasks.json`, reports each finished task exactly once, and stays silent otherwise.

## How it behaves

- **Stateless per call** — a new process and exactly one turn; nothing to supervise, nothing to
  leak between tasks.
- **Overlay, not profile surgery** — configuration arrives as `dsh --patch` layers, so your
  existing profiles are never rewritten.
- **Bounded concurrency** — `DSH_SUBAGENT_MAX_CONCURRENCY` (default 2) with a FIFO queue; extra
  calls return `queued` plus their position.
- **Usage reporting** — tokens, tool calls and names, `startup_ms` / `work_ms`, `exit_code`,
  `error_code` (`TIMEOUT`, `CANCELLED`, `SPAWN_FAILED`, `EMPTY_ANSWER`, `CHILD_EXIT`, `RATE_LIMIT`).
- **Oversized answers** — above `DSH_SUBAGENT_INLINE_LIMIT` (default 24000 chars) the full text
  spills to `state/results/<task>.md`; the reply states the percentage shown.
- **No orphans** — cancellation and shutdown kill the whole process tree.

## Security

- **`cwd` is not a sandbox.** It selects the working directory only; the child inherits the host
  user's filesystem and network rights.
- **`read_only` is advisory.** Enforced by instruction and reported by detection, not by the kernel.
- The child inherits `DSH_HOME`, so it reads your `AGENTS.md`, skills and stored credentials.
- Nothing is sent anywhere beyond the model provider you configured.

## Differences and limits

Deliberately stateless: a process per task, one turn, then exit. That keeps the failure surface
small and the billing predictable, and it means there is

- no daemon and no queue beyond the in-process FIFO;
- no native "wake the parent when done" callback — that needs host hooks, above;
- no way to attach to a DSH session already running elsewhere;
- no streaming and no mid-run questions — use `subagent_dsh_continue` for follow-ups;
- no visibility from the host into the child's conversation; only the final answer crosses back.

Several host windows each run their own server instance and share `state/tasks.json`, so hook
notifications can duplicate.

## Built on

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This is the reverse of
[`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex),
which lets DSH drive a Codex thread.

## Author

Built and maintained by [@mbj733](https://github.com/mbj733). MIT licensed.
