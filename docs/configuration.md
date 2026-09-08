# Configuration Reference

Hearth stores durable settings in `~/.hearth/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/hearth.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.hearth/config.jsonc
~/.hearth/auth.json
```

Run `hearth init` to create both files. `hearth config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/hearth/main/schema/v1/hearth.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7176,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://hearth.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.hearth/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/hearth",
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["hearth"],
    "allowedRedirectHosts": ["chatgpt.com", "claude.ai", "anthropic.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

Hearth attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

## Skills and subagents

Hearth discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.hearth/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

Profiles are loaded from `~/.hearth/agents/*.md` and project
`.hearth/agents/*.md`. `hearth agents targets` prints the configured targets
available in the current workspace.

Provider executable discovery remains process-scoped. The supported overrides
are `CODEX_COMMAND`, `CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`,
`COPILOT_COMMAND`, `GROK_COMMAND`, and `GROK_AGENT_PROFILE`. Hearth does not
persist provider credentials.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Environment boundary

User-facing Hearth environment variables (the only ones read from the environment; provider-specific overrides such as `CODEX_COMMAND`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`, `COPILOT_COMMAND`, `GROK_COMMAND`, `GROK_AGENT_PROFILE`, `CODEX_HOME` are read by the subagent layer):

| Variable | Purpose |
| --- | --- |
| `HEARTH_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `HEARTH_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `HEARTH_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `HEARTH_ALLOWED_HOSTS` | `server.allowedHosts` |
| `HEARTH_TRUST_PROXY` | `server.trustProxy` |
| `HEARTH_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `HEARTH_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `HEARTH_STATE_DIR` | `storage.stateDir` |
| `HEARTH_TOOL_MODE`, `HEARTH_MINIMAL_TOOLS` | `tools.mode` |
| `HEARTH_WIDGETS` | `ui.enabled` |
| `HEARTH_ARTIFACTS` | `artifacts.enabled` |
| `HEARTH_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `HEARTH_SKILLS` | `skills.enabled` |
| `HEARTH_SKILL_PATHS` | `skills.paths` |
| `HEARTH_AGENT_DIR` | `skills.agentDir` |
| `HEARTH_SUBAGENTS` | `subagents.enabled` |
| `HEARTH_LOG_LEVEL` | `logging.level` |
| `HEARTH_LOG_FORMAT` | `logging.format` |
| `HEARTH_LOG_REQUESTS` | `logging.requests` |
| `HEARTH_LOG_ASSETS` | `logging.assets` |
| `HEARTH_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `HEARTH_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `HEARTH_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `HEARTH_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `HEARTH_OAUTH_SCOPES` | `oauth.scopes` |
| `HEARTH_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file Hearth can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, Hearth never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
