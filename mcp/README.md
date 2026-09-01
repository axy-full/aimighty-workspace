# Connect the workspace to Claude

This turns Particl into something Claude can operate: write a
shot, wait for it, pull the file down, check what the month has cost — all
from a conversation.

It is one file with no dependencies. Nothing to install, nothing to keep
updated.

## 1. Make a token

In the workspace: **Settings → API tokens → New token — can render**.

Give it a name (`Claude`), and a monthly ceiling in dollars. The ceiling is
the safety rail: an agent that misreads a brief and loops can only ever spend
up to it. The token is shown once — copy it then.

A token acts as *you*, so anything it renders appears under your name, in the
project you asked for, and on the ledger like any other render.

## 2. Add it to Claude

**Claude Code** — one command:

```bash
claude mcp add aimighty --env PARTICL_URL=https://workspace.aimighty.studio --env PARTICL_TOKEN=aw_your_token_here -- node /Users/axy/Downloads/ark-video/mcp/particl-mcp.mjs
```

**Claude Desktop** — add this to `claude_desktop_config.json`
(Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "particl": {
      "command": "node",
      "args": ["/Users/axy/Downloads/ark-video/mcp/particl-mcp.mjs"],
      "env": {
        "PARTICL_URL": "https://workspace.aimighty.studio",
        "PARTICL_TOKEN": "aw_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

## 3. Check it before you rely on it

```bash
PARTICL_URL=https://workspace.aimighty.studio \
PARTICL_TOKEN=aw_your_token_here \
node mcp/particl-mcp.mjs --check
```

It prints what it can see — spend, credit, projects — or says exactly what is
wrong. That separates a configuration problem from a protocol one in about a
second.

## What Claude can then do

| Tool | What it does |
|---|---|
| `render_shot` | Starts a render. Returns an id immediately. |
| `wait_for_render` | Waits for one to finish and reports what it cost. |
| `get_render` | Details, and saves the mp4 or png to a path you name. |
| `list_renders` | Recent work, filterable by project, status or prompt text. |
| `list_projects` | Projects with counts and spend. |
| `create_project` | Makes a new one. |
| `usage_summary` | Spent, credit remaining, renders in flight. |

Projects are addressed by **name**, not id — "put it in Monsoon Film" works.

So does this:

> Render three variations of a slow dolly through monsoon rain on Marine
> Drive at 1080p, put them in Monsoon Film, and save the best one to my
> desktop when they're done.

## Worth knowing

- **It spends real money.** Every `render_shot` bills the BytePlus account at
  the same rates the app shows. The ceiling on the token is what bounds it.
- **Prompts are auto-refined** with ByteDance's Seedance recipe before
  rendering, exactly as in the app. Prefix a prompt with `raw:` to send your
  exact words instead.
- **Read-only tokens exist** — make one of those for anything that should be
  able to look but never bill: it can list, fetch and download, and a render
  request is refused with a clear reason.
- **Revocation is instant.** Every request checks the token, so revoking one
  in Settings stops it mid-conversation.
- The token is never logged, and only its SHA-256 is stored in the database.
