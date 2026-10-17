# dsh-subagent-mcp

MCP server that lets any MCP host — Codex, Claude Code, or your own agent — **delegate a
self-contained task to a brand-new [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) agent** and get the final answer back.

It is the reverse of [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex):
that package lets a DSH agent drive a fresh Codex thread; this one lets an MCP host drive a
fresh DSH run.

| | `dsh-subagent-codex` | this package |
|---|---|---|
| Direction | DSH → Codex | host → DSH |
| Shape | native DSH subagent provider | MCP server |
| Child process | `codex app-server` | `dsh --profile … --json` |
| Config inheritance | `CODEX_HOME` | `DSH_HOME` |
| Lifetime | new process, one turn | new process, one turn (+ explicit continue) |
| Window | none | none |

## Why

A DSH agent is one process with one context. When another agent needs DSH's skills,
filesystem access or long-running turns, driving it through a GUI costs a screen or DOM
round-trip per step. This bridge replaces that with one tool call.

## Requirements

- Node.js ≥ 22.19
- A working `dsh` installation (`npm i @deepseek-ai/dsh@0.2.1-rc.2` — version `next` on npm
  matches the desktop app)
- Some way to authenticate the model: a DSH account sign-in, or a provider key in
  `$DSH_HOME/.env`

## Install

```bash
git clone https://github.com/mbj733/dsh-subagent-mcp
cd dsh-subagent-mcp
npm install          # pulls @deepseek-ai/dsh, which ships the `dsh` CLI
```

Then register it with your MCP host.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.dsh_subagent]
command = 'node'
args = ['/absolute/path/to/dsh-subagent-mcp/index.mjs']
startup_timeout_sec = 30
```

The server creates its own profile (`$DSH_HOME/profiles/dsh-subagent`) from the shipped
headless template on first use. It never modifies your existing profiles.

## Tools

| Tool | Overlay | What it does |
|---|---|---|
| `subagent_dsh` | lite | Delegate a task. Skills, shell, file editing, web search — **no MCP tools**. ≈9k input tokens. |
| `subagent_dsh_full` | full | Same plus the MCP servers declared in `overlay.yml`. ≈300k input tokens when a dozen servers are mounted. |
| `subagent_dsh_status` | — | Collect a task. Accepts a task id (`t-…`) or a dsh session id. |
| `subagent_dsh_continue` | — | Send a follow-up to the same dsh session; `cwd`/`overlay` default to the remembered values. |
| `subagent_dsh_cancel` | — | Kill a running (or queued) task and its whole process tree. |

Common arguments:

| Argument | Default | Meaning |
|---|---|---|
| `prompt` | — | Required. The child cannot see the host conversation, so include everything. |
| `cwd` | — | Required. Absolute path of the project directory. **Not a sandbox** — see Security. |
| `wait_sec` | 120 | How long to wait before returning a task id. `0` returns immediately. |
| `timeout_sec` | 1800 | Hard limit; the whole process tree is killed and partial output returned. |
| `read_only` | false | Ask the child to make no filesystem changes (instruction + detection, not a kernel sandbox). |
| `format` | text | `json` returns `{ok, state, answer, usage, meta}` for programmatic use. |

## Overlays

`overlay.lite.yml` and `overlay.yml` are passed to `dsh` as `--patch` layers, so they apply to
the child process only. Nothing is written into your profile.

- **lite** — restores the managed credential store (the shipped headless profile disables it),
  sets the model route, adds extra skill roots.
- **full** — adds MCP servers. Credentials come from the environment
  (`FIRECRAWL_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `AMAP_API_KEY`); unset ones simply fail
  softly because `failOnStartupError: false` is set.

## Optional: report finished tasks back into the host

MCP has no channel for a late result, so long tasks return a task id instead of a message.
On hosts with hooks you can close that gap: `notify-hook.mjs` writes any finished task into
the next turn as `additionalContext`.

```toml
# Codex: `type = "command"` is mandatory — a missing type breaks the whole config.
[[hooks.PostToolUse]]

[[hooks.PostToolUse.hooks]]
type = "command"
command = "'node' '/absolute/path/to/dsh-subagent-mcp/notify-hook.mjs' PostToolUse"
timeout = 5
```

The hook reads `state/tasks.json`, reports each finished task once, and stays silent otherwise.

## Behaviour details

- **Bounded concurrency** (`DSH_SUBAGENT_MAX_CONCURRENCY`, default 2) with a FIFO queue; extra
  calls return `queued` plus a position.
- **Usage reporting**: token counts, tool-call count and names, `startup_ms` / `work_ms`,
  `exit_code`, `error_code` (`TIMEOUT`, `CANCELLED`, `SPAWN_FAILED`, `EMPTY_ANSWER`,
  `CHILD_EXIT`, `RATE_LIMIT`).
- **Oversized answers** (> `DSH_SUBAGENT_INLINE_LIMIT`, default 24000 chars) spill to
  `state/results/<task>.md`; the reply says how much was shown and how to fetch the rest.
- **No orphans**: cancellation and shutdown use `taskkill /T /F` on Windows (process-tree kill),
  `SIGKILL` elsewhere.

## Security

- **`cwd` is not a sandbox.** It only selects the working directory. The child inherits the
  host user's filesystem and network rights.
- **`read_only` is advisory.** It is enforced by instruction and reported by detection; it is
  not a kernel-level restriction.
- The child inherits `DSH_HOME`, so it reads your `AGENTS.md`, skills and stored credentials.
- Nothing is sent to a third party beyond the model provider you configured.

## Limitations

- One turn per call; no streaming, no questions mid-run. Use `subagent_dsh_continue` for follow-ups.
- The host cannot see the child's conversation; only the final answer crosses back.
- Multiple host windows each run their own server instance and share `state/tasks.json`, so
  hook notifications may duplicate.

## Author

Built and maintained by [@mbj733](https://github.com/mbj733).

## License

MIT.
