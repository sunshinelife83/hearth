# Setup Guide

This guide covers ChatGPT and Coding Agents using Hearth with local projects.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local Hearth server, only when
  ChatGPT will connect

ChatGPT users need a public HTTPS URL forwarding to the local server. The
supported way is the managed ngrok tunnel:

1. **Managed per-PC tunnel (the only remote path):** `hearth ngrok setup`
   saves this PC's static domain — see
   [Managed Tunnel](#managed-tunnel-every-pc-is-server-url-and-tunnel).

## Install And Configure

Run:

```bash
npx @sunshinelife83/hearth init
```

The setup flow asks one question at a time.

First choose where you will use Hearth: ChatGPT, Coding Agents, or both.
Hearth uses that answer to skip setup that does not apply to you.

### Project roots

If you selected ChatGPT, choose the project folders it may open through
Hearth. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

A Coding Agents-only setup skips this question. Direct `hearth agents`
commands use the current Git project, or the current directory outside a
repository, with the authority of your local shell. MCP workspace operations
remain limited to the roots configured for ChatGPT.

### Coding Agents

Setup detects supported Coding Agents and asks which ones Hearth may use.
These choices are stored as provider objects under `subagents` in
`~/.hearth/config.jsonc`.

If you selected Coding Agents, setup prints:

```bash
npx skills add sunshinelife83/hearth --skill subagents --global
```

The Skills CLI asks which installed Coding Agents should receive the skill.
The skill uses `hearth agents targets`, `run`, `continue`, `show`, and `ls`.
These commands do not require `hearth serve`.

### Connect ChatGPT

Setup only asks for a public URL if you selected ChatGPT. Enter your static
ngrok domain as the public origin without `/mcp` (run
`hearth ngrok setup` first if you have not saved one yet):

```text
https://xxx.ngrok-free.dev
```

Configure the MCP client with the full MCP endpoint:

```text
https://xxx.ngrok-free.dev/mcp
```

Protocol compatibility is automatic. Hearth serves MCP 2026-07-28 requests
directly and handles older 2025-era clients statelessly on the same endpoint;
there is no client-protocol setting to maintain.

A Coding Agents-only setup skips this section.

## Start The Server

Run:

```bash
npx @sunshinelife83/hearth serve --ngrok
```

The static domain never changes, so no URL resync is ever needed. If you
replace the domain, update the persisted value before starting:

```bash
npx @sunshinelife83/hearth ngrok setup --domain https://new-domain.ngrok-free.dev
npx @sunshinelife83/hearth serve --ngrok
```

Use the origin only — never append `/mcp` to `publicBaseUrl`. The client URL is
`<origin>/mcp`. `hearth doctor --fix` repairs a saved `/mcp` suffix.

## Managed Tunnel: Every PC Is Server, URL, And Tunnel

`hearth ngrok setup` binds this PC to its static ngrok domain, so
`hearth serve --ngrok` alone is server + stable public URL + tunnel. No
second terminal, no pasted tunnel URLs, no hostname churn on restart.

Prerequisites (once per PC):

- an ngrok account (free is enough — every account gets one stable dev
  domain such as `xxx.ngrok-free.dev`)
- `ngrok` installed (`brew install ngrok`, the Linux package for your
  distro, or `winget install --id Ngrok.ngrok`)
- `ngrok config add-authtoken <your-token>` completed once (token from
  https://dashboard.ngrok.com/get-started/your-authtoken)

Then:

```bash
hearth ngrok setup --domain xxx.ngrok-free.dev
hearth serve --ngrok
hearth ngrok status
```

What setup does: saves the static domain, syncs `server.publicBaseUrl`, and
enables `server.trustProxy` so rate limits see real client IPs. Your
authtoken stays in ngrok's own config — Hearth never stores it. Scripted
setups can pass `--yes` (requires `--domain`).

`hearth serve --ngrok` supervises the ngrok agent and fails fast if the live
domain drifts from the saved one, instead of serving locally-but-dark.
`hearth doctor` checks the binary, auth, domain match, and child liveness.
Plain `hearth serve` stays local-only.

Note: ngrok free shows a browser interstitial page on HTML traffic. API calls
are unaffected; the Owner approval page needs one click-through.

## Connect A Host (ChatGPT / Claude / Generic)

Run:

```bash
npx @sunshinelife83/hearth connect
```

It prints this PC's machine label, public `/mcp` URL, and copy-paste steps per
host. Use `hearth connect chatgpt|claude|generic` for one host. The dashboard
Connect tab shows the same. Keep one public URL per PC: OAuth
tokens are bound to that machine's resource URL and Owner password. The
machine label is diagnostic only and does not prevent cloning (see
`docs/security.md`).

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, Hearth shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.hearth/config.jsonc
~/.hearth/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @sunshinelife83/hearth doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing Hearth itself instead of using the published package:

Local checkout development additionally requires pnpm 11.25.0, the version
pinned in `package.json`. Install it with `npm install --global pnpm@11.25.0`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The same setup rules apply.
