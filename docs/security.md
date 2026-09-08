# Security Model

Hearth exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

Hearth only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`hearth init` generates an Owner password and stores it in:

```text
~/.hearth/auth.json
```

When an MCP client connects, Hearth shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
HEARTH_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

Hearth needs `server.publicBaseUrl` in `config.jsonc` so MCP clients can
discover OAuth metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `server.publicBaseUrl`.

By default, Hearth derives allowed Host headers from the local host and public
URL. Put `"*"` in `server.allowedHosts` only for intentional local debugging.

## Tunnels

Hearth does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7176
```

Prefer adding an identity-aware proxy in front of public tunnels. Hearth
OAuth still protects the MCP endpoint, but the tunnel URL should not be
treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to Hearth file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

Hearth accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. Hearth does not extract or
execute transferred content.

## Logs

By default, Hearth logs requests and tool calls. Shell command previews are
disabled unless `logging.shellCommands` is `true`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

## Command policy and environment filtering (Hearth)
Model-invoked shell tools (`exec_command`, `bash`) pass through a policy gate
before any process spawns:

- **Tier 0** — inspection (`git status`, `ls`, `grep`, ...): allowed in every mode.
- **Tier 1** — ordinary workspace work (builds, tests, local edits): allowed above readonly.
- **Tier 2** — outside-effect commands (network fetches, package installs, recursive
  deletes, `git push`, permission changes, cloud CLIs): denied in readonly, require an
  explicit `approvedByUser` claim in `supervised` mode (after the user approves in the
  conversation; the claim is audited), and run freely in `autonomous` mode after a
  best-effort git snapshot.
- **Tier 3** — always blocked with no approval path: privilege escalation (`sudo`, `su`),
  system/power management, service managers, cron, piping remote scripts into a shell,
  SSH remote execution, and shell-profile tampering.

Set the mode with `execution.mode` in `config.jsonc` (`readonly`, `supervised` — the
default — or `autonomous`). Every decision is logged as a `policy_decision` event.

Commands executed by model-invoked shell tools inherit a conservative environment
allowlist instead of the full user environment, so model-run commands cannot read
API keys or cloud credentials from the environment (escape hatches:
`execution.envAllowAll`, `execution.envAllowlist`). Provider CLIs started by the
subagent layer keep the full environment by design and are constrained by the
allowed-roots enforcement described in
docs/adr/hearth-x-implementation-adrs.md (ADR-014/015).

Workspace snapshots (`create_snapshot`, `list_snapshots`, `rollback_snapshot`) capture
the working tree as git refs under `refs/hearth/snapshots/...`; rollback restores
content without touching HEAD and is subject to the same tier-2 policy.

The OAuth consent page is CSRF-protected (HMAC bound to the authorization request,
`frame-ancestors 'none'`), and the auth endpoints are rate limited (`/authorize`,
`/register`, `/token`, plus a dedicated failure counter for the owner password).
Enable `server.trustProxy` when running behind a tunnel so rate-limit keys use the
real client IP.

## OS sandbox (platform honesty)

Autonomous shell execution and verification gates are wrapped in an OS sandbox
when an adapter is available. The sandbox is a hardening layer on top of the
policy engine, never the only boundary.

| Platform | Adapter | What it actually provides |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Read-only root bind, workspace + `/tmp` writable, optional `--unshare-net`. Real filesystem containment. |
| macOS | `sandbox-exec` (seatbelt) | Profile denying writes outside the workspace and temp dirs. Approximate; not a strict container. |
| Windows | none | No equivalent exists here. Containers are the recommended hardening path. |

Fail-closed default: `execution.requireSandboxForAutonomous` defaults to
`true`, so autonomous tier-2 commands are **denied** (with instructions) when
no adapter is available — notably on Windows — instead of running silently
unsandboxed. Opt out explicitly (`execution.requireSandboxForAutonomous:
false`, globally or per workspace profile) only when you accept unsandboxed
autonomy. Per-workspace `sandbox: "auto" | "none"` and `sandboxNetwork:
"allow" | "deny"` override the global setting for one workspace only.
