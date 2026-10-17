# Agent notes for this repository

This file is for agents that install, verify or modify `dsh-subagent-mcp`.

## Install, in order of preference

1. `npx -y github:mbj733/dsh-subagent-mcp` — no clone, no account.
2. Pinned tarball from the matching GitHub Release:
   `npm i -g https://github.com/mbj733/dsh-subagent-mcp/releases/download/v0.5.0/mbj733-dsh-subagent-mcp-0.5.0.tgz`
3. `git clone` + `npm install` — use when the user wants to read or patch the code.

Do not install from npm: the unscoped name `dsh-subagent-mcp` belongs to an unrelated project.

## Registering with a host

- Codex: append an `[mcp_servers.dsh_subagent]` block to `~/.codex/config.toml`.
  Hook entries in that file **require `type = "command"`**; omitting it makes the whole config
  fail to load with `missing field type`.
- Claude Desktop / Cursor: merge into the `mcpServers` object of their JSON config.
- Always restart the host: stdio MCP servers are loaded once at startup.

## Verifying without a host

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npx -y github:mbj733/dsh-subagent-mcp
```

Expected: an `initialize` result with `serverInfo.name = dsh-subagent-mcp`, then five tools.

## Conventions in this codebase

- `index.mjs` is the whole server. No dependencies, no build step — the MCP stdio protocol is a
  small newline-delimited JSON-RPC implementation on purpose. Keep it that way unless the user
  asks otherwise.
- `overlay.lite.yml` / `overlay.yml` are passed to `dsh` as `--patch` layers. Never write into a
  user profile; add a patch layer instead.
- Credentials belong in environment variables (`process.env.X`) — never inline them.
- The child process must be killed as a tree (`taskkill /T /F` on Windows). A plain `kill()`
  orphans the MCP servers that `dsh` spawned.

## Privacy

Commits and package metadata carry only the handle `mbj733`. Do not add real names, personal
paths, tokens or email addresses to any tracked file.
