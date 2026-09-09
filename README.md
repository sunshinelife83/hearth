<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/sunshinelife83/hearth/main/docs/assets/hearth-logo-light.png" alt="Hearth logo" width="140">
  </picture>
</p>

<h1 align="center">Hearth</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sunshinelife83/hearth"><img alt="npm" src="https://img.shields.io/npm/v/%40sunshinelife83%2Fhearth?style=flat-square" /></a>
  <a href="https://github.com/sunshinelife83/hearth/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/sunshinelife83/hearth/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/sunshinelife83/hearth/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40sunshinelife83%2Fhearth?style=flat-square" /></a>
</p>

[![Hearth connected to ChatGPT](https://raw.githubusercontent.com/sunshinelife83/hearth/main/docs/assets/hearth-screenshot.png)](https://raw.githubusercontent.com/sunshinelife83/hearth/main/docs/assets/hearth-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

Hearth is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through its own managed tunnel, and approve the connection with a password only you have.

The same `/mcp` endpoint serves the 2026-07-28 per-request protocol and automatically supports older 2025-era clients through stateless compatibility handling. There is no protocol mode to configure.

## Installation

Hearth requires Node `>=22.19 <27`.

Install the Hearth CLI (works like `opencode` once installed):

```bash
npm install -g @sunshinelife83/hearth
```

If you prefer building from source, install from a checkout instead:
`./install.sh`, or `npm pack` plus
`HEARTH_PKG=./sunshinelife83-hearth-*.tgz ./install.sh`.

Then initialize Hearth:

```bash
hearth init
```

Non-interactive (scripts, second machine):

```bash
hearth init --yes --use both --roots ~/personal,~/work --public-url https://xxx.ngrok-free.dev
```

Or one line from a checkout (checks Node, packs, installs, then runs setup
when interactive):

```bash
./install.sh
```

Or run it without a global install:

```bash
npx @sunshinelife83/hearth init
```

During setup, Hearth asks for:

- where you will use it: ChatGPT, Coding Agents, or both
- which Coding Agents Hearth may use

If you select ChatGPT, setup also asks which local project folders it may open
and for your public HTTPS base URL — your static ngrok domain (see
[Managed Tunnel](#managed-tunnel) below).
A Coding Agents-only setup asks
neither question: local commands use the current Git project, or the current
directory outside a repository.

Use the public origin without `/mcp` during setup:

```text
https://xxx.ngrok-free.dev
```

You will configure your MCP client with the public `/mcp` URL after setup.
Run `hearth serve --ngrok` when using ChatGPT. For Coding Agents, setup prints a
`skills` command and lets the Skills CLI handle installation.

When the client connects, Hearth opens an Owner password approval page. Enter
the Owner password printed by `hearth init`. It is also stored in:

```text
~/.hearth/auth.json
```

Keep that password private.

## Connect Your MCP Client

Run `hearth connect` for this PC's exact steps (also in the dashboard Connect
tab). Each PC has a stable `hearth-xxxx` diagnostic label (`hearth id` — it
helps recognize the PC but does not prevent cloning); keep one public URL per
PC as operational hygiene.

The default local endpoint is:

```text
http://127.0.0.1:7176/mcp
```

Most users should connect through the managed ngrok tunnel:

```text
https://xxx.ngrok-free.dev/mcp
```

ChatGPT, Claude, and generic MCP clients all use the same `/mcp` endpoint.
Claude needs `claude.ai` in `oauth.allowedRedirectHosts` (default since v1.1).
Local-only clients can use `hearth mcp` stdio with `hearth token create <name>`.

> [!NOTE]
> Using Hearth as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> Hearth. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

Hearth gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Local Dashboard

`hearth serve` also serves a local ops console at:
```text
http://127.0.0.1:7176/dashboard
```

Sign in with the Owner password. The dashboard covers installation status,
workspaces, background agents, tasks with verification state, recent logs,
snapshots, and safe config edits (execution mode, sandbox settings, fleet
lanes, workspace profiles). Config edits take effect after restarting the
server.

The dashboard performs no privileged execution of its own: it shows the same
policy-gated state the MCP surface sees, and agents/tasks are still driven
from your MCP client.

## Managed Tunnel

Hearth exposes this PC through ngrok — the only remote-access path. Each PC
gets its stable ngrok domain, and `hearth serve --ngrok` is server, URL, and
tunnel in one command:

```bash
ngrok config add-authtoken <your-token>   # once; token from dashboard.ngrok.com
hearth ngrok setup --domain xxx.ngrok-free.dev
hearth serve --ngrok
hearth ngrok status    # health: binary, auth, live domain match
hearth id              # stable per-PC identity (hearth-xxxx...)
```

Only AI endpoints (`/mcp`, OAuth, discovery, health) are reachable through
the tunnel: the landing page and dashboard 404 remotely by Host and stay
localhost-only. `hearth doctor` checks the binary, auth, domain match, and
child liveness.

## Mental Model

Hearth is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Run `hearth serve --ngrok`.
2. Connect the MCP client to your public `/mcp` URL.
3. Approve the connection with the Owner password.
4. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

Hearth supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
hearth doctor
```

## Documentation

- [Setup Guide](https://github.com/sunshinelife83/hearth/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/sunshinelife83/hearth/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/sunshinelife83/hearth/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/sunshinelife83/hearth/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/sunshinelife83/hearth/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/sunshinelife83/hearth/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

Hearth is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Origin

Hearth is built on **DevSpace** — the local development execution layer it
grew out of. The workspace model (one directory plus its accumulated
instructions), the MCP tool surface, and the explicit-lifecycle philosophy
come straight from that foundation. Hearth carries them forward as a
self-contained product: one command to install, one command to serve, managed
tunneling per PC, and first-class support for ChatGPT, Claude, and any
MCP-compatible host.

Its orchestration layer — self-contained task briefs, fleet lanes with
audited approvals, per-turn watchdogs, and pre-delegation snapshots — takes
design inspiration from
[delegate-skills](https://github.com/amElnagdy/delegate-skills) by amElnagdy
(a design reference for the coordination patterns, not a code dependency:
Hearth's orchestration is implemented natively in `src/orchestration/`).

## Built by Mounib Bouchareb

Hearth is built and maintained by [Mounib Bouchareb](https://github.com/sunshinelife83)
([@sunshinelife83](https://github.com/sunshinelife83) on GitHub) — opinionated
local-first tooling for the agentic era: your machine, your projects, your
models, no middlemen.

## Local Development

For working on Hearth itself:

Install pnpm 11.25.0, the version pinned in `package.json`, with
`npm install --global pnpm@11.25.0`, then:

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```
