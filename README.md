<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/hearth/main/docs/assets/hearth-logo-light.png" alt="Hearth logo" width="140">
  </picture>
</p>

<h1 align="center">Hearth</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/hearth"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fhearth?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/hearth/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/hearth/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/hearth/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fhearth?style=flat-square" /></a>
</p>

[![Hearth connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/hearth/main/docs/assets/hearth-screenshot.png)](https://raw.githubusercontent.com/Waishnav/hearth/main/docs/assets/hearth-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

Hearth is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

The same `/mcp` endpoint serves the 2026-07-28 per-request protocol and automatically supports older 2025-era clients through stateless compatibility handling. There is no protocol mode to configure.

## Sponsors and Special Thanks
<!-- 

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>
-->
<p>
  Hearth is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

Hearth requires Node `>=22.19 <27`.

Install the Hearth CLI (works like `opencode` once installed):

```bash
npm install -g @waishnav/hearth
```

If the registry publish is not live yet, install from a source checkout instead:
`./install.sh`, or `npm pack` plus
`HEARTH_PKG=./waishnav-hearth-*.tgz ./install.sh`.

Then initialize Hearth:

```bash
hearth init
```

Non-interactive (scripts, second machine):

```bash
hearth init --yes --use both --roots ~/personal,~/work --public-url https://your-tunnel-host.example.com
```

Or one line from a checkout (checks Node, packs, installs, then runs setup
when interactive):

```bash
./install.sh
```

Or run it without a global install:

```bash
npx @waishnav/hearth init
```

During setup, Hearth asks for:

- where you will use it: ChatGPT, Coding Agents, or both
- which Coding Agents Hearth may use

If you select ChatGPT, setup also asks which local project folders it may open
and for your public HTTPS base URL from a tunnel or reverse proxy you control.
A Coding Agents-only setup asks
neither question: local commands use the current Git project, or the current
directory outside a repository.

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.
Run `hearth serve` when using ChatGPT. For Coding Agents, setup prints a
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

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
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

## Direct Exposure Without a Relay

No software can give your PC a public URL with zero outside help: ChatGPT must
reach a public IP over valid HTTPS. What Hearth removes is the *relay
middleman*. If you have a domain and an inbound route to this machine:

```bash
hearth expose    # reports this PC's identity and exactly what's missing
hearth id        # stable per-PC identity (hearth-xxxx...)
```

Then: point your domain at the machine, forward TCP 443 (and 80 for issuance),
issue a certificate with certbot webroot against `tls.acmeDir`, set
`tls.certFile`/`tls.keyFile`, run `hearth config set publicBaseUrl
https://your-domain`, and restart serve. Hearth terminates TLS itself and
serves the ACME challenge path. Without an inbound route + domain, traffic
needs *some* relay — run your own (e.g. on your VPS), never one you don't
control.

## Mental Model

Hearth is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `hearth serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

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

- [Setup Guide](https://github.com/Waishnav/hearth/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/hearth/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/hearth/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/hearth/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/hearth/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/hearth/blob/main/docs/gotchas.md)

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

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and Artifacts is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

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
