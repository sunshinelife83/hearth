# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `hearth` Command Not Found

Use `npx`:

```bash
npx @sunshinelive83/hearth init
npx @sunshinelive83/hearth serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

Hearth requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @sunshinelive83/hearth doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @sunshinelive83/hearth config set publicBaseUrl https://your-tunnel-host.example.com
```

## Reverse Proxy `/mcp` Returns 404
Proxy the whole Hearth server from the root of your tunnel or reverse proxy.

Do not mount only `/mcp`: some proxies strip a configured mount path before
proxying to the local service, so a public `/mcp` request can otherwise arrive
at Hearth as `/`. Hearth also needs OAuth routes outside `/mcp`, so serving
the whole local origin is the correct setup.

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

Update the configured URL:

```bash
npx @sunshinelive83/hearth config set publicBaseUrl https://new-tunnel.example.com
```

For a stable URL:

```bash
npx @sunshinelive83/hearth config set publicBaseUrl https://hearth.example.com
```

## Host Header Or 403 Problems

Hearth derives allowed hosts from the configured public URL.

Run:

```bash
npx @sunshinelive83/hearth doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

For intentional local debugging only, set `server.allowedHosts` to `["*"]` in
`~/.hearth/config.jsonc`.

## OAuth Redirect Host Rejected

By default, Hearth allows redirects for:

```text
chatgpt.com (and subdomains)
claude.ai (and subdomains)
anthropic.com (and subdomains)
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, add it to
`oauth.allowedRedirectHosts` in `~/.hearth/config.jsonc`. Subdomains of a
listed host are accepted automatically.

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.hearth/auth.json
```

To regenerate setup:

```bash
npx @sunshinelive83/hearth init --force
  (`--force` now rotates the Owner password and prints the new value in ChatGPT setups; existing access tokens stay valid until they expire — revoke them via the OAuth revocation endpoint if needed)
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted. ChatGPT may provide optional
conversation metadata that lets Hearth resume the same checkout workspace for
the same project in that conversation; repeated opens reuse the `workspaceId`
and do not repeat context already provided for that reused checkout. Worktree
mode always creates a new isolated workspace with its own complete context.
Hosts without supported conversation metadata receive a normal new workspace.
In all cases, continue passing the `workspaceId` returned by `open_workspace` to
later tools. Other MCP hosts use this explicit workspace workflow as well.

To review work, call `show_changes` once after the final related file change. It
shows the combined changes and advances the review point automatically.

## Data Retention

Hearth does not currently prune workspace sessions, conversation bindings,
or review refs. A future product retention policy will define safe cleanup for
these records; no automatic deletion is performed today.

## MCP Workspace Path Rejected

The path passed to `open_workspace` must be inside one of the allowed roots
configured during ChatGPT setup. Direct `hearth agents` commands instead use
the current local project and are not gated by MCP allowed roots.

Run:

```bash
npx @sunshinelive83/hearth config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @sunshinelive83/hearth init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

Hearth shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @sunshinelive83/hearth doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Confirm `skills.enabled` is `true` in
`~/.hearth/config.jsonc`.

Hearth looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.hearth/skills`

It also checks compatibility and custom paths:

- the bundled `subagents` skill when Subagents are enabled, unless `~/.hearth/skills/subagents/SKILL.md` exists
- `skills.agentDir/skills`, defaulting to `~/.codex/skills`
- additional paths from `skills.paths`

When Subagents are enabled, Hearth loads agent profiles from
`~/.hearth/agents/*.md` and project `.hearth/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. The bundled
`subagents` skill keeps the model-facing workflow to
`hearth agents targets`, `hearth agents ls`, `hearth agents run`,
`hearth agents continue`, and `hearth agents show`.
Those commands automatically manage the internal local agent daemon; `hearth
serve` is not a prerequisite.
`hearth agents ls` lists existing subagent sessions, not profile
definitions.

For a Coding Agent, run the installation command printed by
`hearth init`:

```bash
npx skills add Waishnav/hearth --skill subagents --global
```

The Skills CLI handles agent discovery and installation. Hearth setup does
not copy files into agent skill directories.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added to `skills.paths` when needed.

If a skill appears in `open_workspace`, the model should read that skill's
`SKILL.md` before following it. Hearth permits reads within advertised skill
directories without tracking whether `SKILL.md` was read first.

## Review Card Does Not Appear

Hearth attaches widget UI only to `open_workspace` and `show_changes`.
Ordinary reads, edits, and commands intentionally render as normal tool results
to avoid one iframe per call. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results; `show_changes` remains available there.

If both cards are missing in ChatGPT, confirm that `ui.enabled` is not `false`
in `~/.hearth/config.jsonc` and reconnect the MCP server.

Historical `show_changes` cards use the `reviewRef` in their structured result
to recover the exact Git-backed review when a host reloads the app without its
original result metadata. `open_workspace` can rebuild its card directly from
its structured result.

## OpenCode Backend Fails With "Unexpected Server Error"

If every opencode turn fails with `PROVIDER_EXECUTION_ERROR: ... Unexpected
server error` while `opencode run` in a terminal works, the opencode server's
local database (`~/.local/share/opencode/opencode.db`) is in a broken state:
sessions created through the API land outside the table that message inserts
reference, so every prompt and agent-switch is rejected. Hearth cannot repair
another program's database.

Confirm it without touching your data:

```bash
mkdir -p /tmp/oc-fresh-data && XDG_DATA_HOME=/tmp/oc-fresh-data opencode serve --hostname=127.0.0.1 --port=18927 &
# dispatch one opencode turn through Hearth with XDG_DATA_HOME set for the daemon,
# or simply: if a fresh data dir works, the old database is the cause.
```

Remedies: back up then reset the opencode database (you lose TUI session
history), or use the `codex` backend, which is unaffected. Hearth-side, every
opencode runtime now gets its own server port (no shared-4096 collisions),
redundant agent switches are skipped, and provider failures carry the
underlying cause text instead of a bare "execution failed".
