# claude-artifacts

Publish Claude Code artifacts from your terminal.

I love Claude Code artifacts. `claude-artifacts` exists because sharing and updating them should be as direct as creating them. Point it at local HTML, Markdown, YAML, CSV, JSON, source code, or another text file, get a Claude artifact URL, and keep updating that same URL without going back through chat.

## What You Can Do

- Publish local HTML, Markdown, data files, source files, and other text files as Claude Code artifacts.
- Update an existing artifact without changing its URL.
- List your Claude Code artifacts with URLs, owners, view counts, and the gallery link.
- Download the live artifact HTML when you need to inspect or archive it.
- Expose the same workflow to Claude Code, Codex, Cursor, and other MCP-capable coding agents.

## Install

```sh
npm install -g claude-artifacts
```

If Claude Code is not logged in yet:

```sh
claude /login
```

## Quickstart

Publish a page:

```sh
claude-artifacts create dashboard.html --title "Launch dashboard"
```

Publish data or source files too:

```sh
claude-artifacts create config.yaml --title "Runtime config"
claude-artifacts create metrics.csv --title "Metrics export"
```

List your artifacts:

```sh
claude-artifacts list
```

Update the same artifact later:

```sh
claude-artifacts update <id> dashboard.html --title "Launch dashboard"
```

Download the live HTML:

```sh
claude-artifacts read <id> --content > deployed.html
```

Delete an artifact:

```sh
claude-artifacts delete <id>
```

## Output

`list` is built for quick scanning:

```text
gallery: https://claude.ai/code/artifacts

1. Launch dashboard
   id:      e2438a48-35b9-46bb-902e-fc59665782e2
   url:     https://claude.ai/code/artifact/e2438a48-35b9-46bb-902e-fc59665782e2
   updated: Jun 23, 2026, 2:28 PM CDT
   label:   launch-v1
   owner:   you@example.com
   access:  mine
   views:   8 total, 1 unique
```

Commands accept either the full Claude artifact URL or just the UUID:

```sh
claude-artifacts read https://claude.ai/code/artifact/<id>
claude-artifacts read <id>
```

## Commands

| Command | Purpose |
| --- | --- |
| `claude-artifacts create <file> [--title <title>] [--favicon <emoji>] [--label <label>]` | Publish a local file as a new artifact. |
| `claude-artifacts list [--limit <n>]` | Show your Claude Code artifacts and gallery URL. |
| `claude-artifacts read <artifact> [--content] [--content-version <version>]` | Read artifact metadata, or include HTML with `--content`. |
| `claude-artifacts update <artifact> <file> [--title <title>] [--favicon <emoji>] [--label <label>] [--base-version <version>]` | Publish a new version to an existing artifact URL. |
| `claude-artifacts delete <artifact>` | Remove an artifact. |
| `claude-artifacts list --types [--query <text>]` | List the Artifact types you can create from. |
| `claude-artifacts create --type <type_url\|name> [--title <title>]` | Create an empty artifact from a type; prints the type's instructions. |
| `claude-artifacts list --type <type_url\|name>` | List artifacts made from a type. |
| `claude-artifacts read <type_url\|name> [--file <path>]` | Show a type's files, or one file. |

`--favicon` is optional. It is a short text icon, usually an emoji, shown by Claude for the artifact.

## Artifact types (Design, Slides, Dashboard, Docs, Design System)

Claude Code can start an artifact from an Artifact type instead of a file. The same flow is available here, so agents without Claude Code's own Artifact tool (Codex and others) can create Design artifacts.

```sh
# the catalog: name, type_url, scope, description
claude-artifacts list --types [--query design]

# the type's files (SKILL.md holds its instructions), or one file of it
claude-artifacts read https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd
claude-artifacts read Design --file SKILL.md

# create an empty artifact from a type: prints the new url and the type's
# SKILL.md instructions verbatim (they say how to fill it)
claude-artifacts create --type https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd --title "Spring menu"
claude-artifacts create --type Design --title "Spring menu" --output json

# artifacts made from a type (for example your design systems)
claude-artifacts list --type "Design System"
```

`--type` takes a `type_url` from `list --types`, the type slug, or the type name. Create takes no file: the artifact starts empty and the type's instructions say what to write next (for Design, files under the artifact's `project/` folder). Filling it is not part of this CLI. The same options are on the MCP tools: `claude_artifacts__create` (`type`), `claude_artifacts__list` (`types`, `query`, `type`) and `claude_artifacts__read` (a type url, `file`).

`update` and `delete` refuse a type url, so a type can never be changed or deleted by mistake.

These use the `/api/frame/types` endpoints Claude Code's Artifact tool uses (`GET /types`, `GET /types/{slug}`, `GET /types/{slug}/files/{path}`, `GET /types/{slug}/instances`, `POST /types/{slug}/create`), so they follow whatever the server enables for your account.

## MCP

Use the MCP server with Claude Code or any other coding agent that supports MCP stdio servers:

```sh
npx -y --package claude-artifacts claude-artifacts-mcp
```

Example MCP config:

```json
{
  "mcpServers": {
    "claude-artifacts": {
      "command": "npx",
      "args": ["-y", "--package", "claude-artifacts", "claude-artifacts-mcp"]
    }
  }
}
```

Available MCP tools:

```text
claude_artifacts__create
claude_artifacts__list
claude_artifacts__read
claude_artifacts__update
claude_artifacts__delete
```

## How Login Works

`claude-artifacts` uses the same Claude Code login already on your machine. There is no separate API key to create or paste.
