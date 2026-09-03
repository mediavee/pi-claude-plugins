# pi-claude-plugins

Load [Claude Code plugins](https://code.claude.com/docs/en/plugins) natively into
[pi](https://pi.dev). Point the extension at a plugin directory or a marketplace checkout and the
plugin's skills, commands, agents, hooks and MCP servers become available in the pi session, with
the semantics a Claude Code user expects.

Works the same in the TUI and headless (`pi --mode rpc`, `pi --mode json`, `pi -p`).

## Install

```bash
pi install npm:pi-claude-plugins
```

Or try it for one run without installing:

```bash
pi -e npm:pi-claude-plugins
```

Requires pi `0.84.4` or later.

## Configure

Add a `claudePlugins` section to `~/.pi/agent/settings.json` (or `.pi/settings.json` for a single
project, which is read only once the project is trusted):

```json
{
  "claudePlugins": {
    "paths": ["~/plugins/acme-tools"],
    "marketplaces": ["~/marketplaces/acme"],
    "allowHooks": false,
    "allowShellCommands": false,
    "trustedPlugins": [],
    "disabledPlugins": [],
    "agents": true
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `paths` | `[]` | Plugin directories. Relative paths resolve against the settings file's directory |
| `marketplaces` | `[]` | Marketplace checkouts containing `.claude-plugin/marketplace.json` |
| `allowHooks` | `false` | Run hooks from every plugin |
| `allowShellCommands` | `false` | Run `` !`command` `` expansions in plugin commands |
| `trustedPlugins` | `[]` | Grant both of the above to named plugins only |
| `disabledPlugins` | `[]` | Skip these plugins entirely |
| `agents` | `true` | Register the subagent tool for plugin agents |

For headless and container use, the environment wins over settings:

| Variable | Effect |
| --- | --- |
| `PI_CLAUDE_PLUGINS` | `PATH`-separated plugin directories, appended to `paths` |
| `PI_CLAUDE_PLUGINS_MARKETPLACES` | `PATH`-separated marketplace directories |
| `PI_CLAUDE_PLUGINS_ALLOW_HOOKS` | `1`/`true` enables hooks |
| `PI_CLAUDE_PLUGINS_ALLOW_SHELL` | `1`/`true` enables `!` expansion |

```bash
PI_CLAUDE_PLUGINS=/srv/plugins/acme pi --mode rpc
```

Run `/claude-plugins` at any time, or read stderr at startup, to see what loaded and what was
refused.

## What maps to what

| Claude Code | pi |
| --- | --- |
| `skills/<name>/SKILL.md` | pi skills, registered through `resources_discover` |
| `commands/*.md` | `/{plugin}:{command}` extension commands |
| `agents/*.md` | The `claude_plugin_agent` tool, which runs the agent in a child `pi` process |
| `hooks/hooks.json` | pi's `tool_call`, `tool_result`, `input`, `agent_end`, `session_start` and `session_before_compact` events |
| `.mcp.json` | Runtime registration with [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) |
| `.claude-plugin/marketplace.json` | Plugin discovery from a local checkout |

### Skills

Plugin skill directories are handed to pi as they are, so relative links, bundled scripts and
assets keep working. pi implements the same Agent Skills standard and exposes each skill as
`/skill:<name>`.

Claude Code namespaces plugin skills as `/plugin:skill`. pi skill names are limited to
`[a-z0-9-]`, so the colon form cannot be reproduced and skills keep their own names. If two
plugins ship a skill with the same name, pi keeps the first and this extension names both
offenders in the startup report.

### Commands

Command bodies get the full Claude Code treatment:

- `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` — **zero-based**, so `$0` is the first argument, matching
  Claude Code rather than pi's one-based prompt templates.
- `$name` for arguments declared in the `arguments` frontmatter key.
- `` !`command` `` and ` ```! ` blocks, gated behind `allowShellCommands`.
- `@path` file references.
- `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`.

When no placeholder consumes the arguments, they are appended as `ARGUMENTS: <value>`, as upstream.

`@path` differs on one point: Claude Code attaches the referenced file, while pi has no attachment
channel for extension-sent messages, so the contents are inlined in a labelled code fence.

### Agents

Each `agents/*.md` file becomes an option of one tool, `claude_plugin_agent`, which spawns a child
`pi` with the agent's system prompt, model and tool allowlist and returns its final output. Claude
tool names map onto pi's:

`Read`→`read`, `Write`→`write`, `Edit`/`MultiEdit`/`NotebookEdit`→`edit`, `Bash`→`bash`,
`Glob`→`find`, `Grep`→`grep`, `LS`→`ls`.

Names with no pi equivalent, such as `Task` or `WebFetch`, are dropped and reported rather than
passed through, since an unknown name would fail the child process. The `hooks`, `mcpServers` and
`permissionMode` frontmatter keys are refused for plugin agents, as they are upstream.

### Hooks

| Claude event | pi event | What a hook can do |
| --- | --- | --- |
| `PreToolUse` | `tool_call` | Deny the call, or rewrite its input with `updatedInput` |
| `PostToolUse` | `tool_result` | Append feedback or `additionalContext` to the result |
| `UserPromptSubmit` | `input` | Block the prompt, or inject `additionalContext` |
| `Stop` | `agent_end` | Block to keep the conversation going, capped at 8 continuations |
| `SessionStart` | `session_start` | Inject `additionalContext` for the first turn |
| `PreCompact` | `session_before_compact` | Block compaction |

Handlers receive Claude Code's JSON on stdin, with `tool_name` in Claude's vocabulary so matchers
written upstream keep firing, and with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and
`CLAUDE_PROJECT_DIR` in their environment. Exit codes and JSON output follow the upstream
protocol: exit `2` blocks with stderr as the reason, valid JSON on stdout is honoured on any exit
code, any other non-zero exit is a non-blocking error. `permissionDecision: "ask"` allows the call
with a warning, because pi's `tool_call` has no "prompt the user" outcome.

Matchers use Claude's rules: a matcher of only word characters, spaces, commas and pipes is a list
of exact names, anything else is an unanchored regular expression.

`tool_input` is translated where the shapes differ, so `Read`, `Write`, `Edit` and `LS` report
`file_path` rather than pi's `path`, and an `updatedInput` coming back is translated in reverse.
Beyond the path, `Edit` keeps pi's `edits[]` array instead of Claude's `old_string`/`new_string`,
so a hook that rewrites edit contents needs pi's shape. A call a `PreToolUse` hook denied never
fires `PostToolUse`, as upstream.

### MCP servers

Servers from `.mcp.json` are registered with `pi-mcp-adapter` at `session_start` and disposed at
`session_shutdown`, under the name `<plugin>__<server>`. `${CLAUDE_*}` placeholders and Claude's
`${VAR}` / `${VAR:-default}` syntax are resolved across `command`, `args`, `env`, `cwd`, `url` and
`headers` before registration.

Without `pi-mcp-adapter` installed, the servers are skipped and named in the startup report.

### Marketplaces

`marketplaces` entries are read from a local checkout. Plugin entries with a relative `./path`
source (or a bare name under `metadata.pluginRoot`) load; `github`, `url`, `git-subdir`, `npm`,
`archive` and `command` sources are reported as unresolved rather than fetched. Cloning and
caching remote sources duplicates what `pi install git:…` already does, so point `marketplaces` at
a checkout you manage.

## Not supported

| Claude Code feature | Why |
| --- | --- |
| `.lsp.json` | pi has no LSP integration point for extensions |
| `monitors/monitors.json` | No pi event delivers background process output as a notification |
| `bin/` on `PATH` | pi's bash tool has no per-extension `PATH` injection hook |
| Plugin `settings.json` (`agent`, `subagentStatusLine`) | Would repoint the main thread's system prompt; too invasive for a loader |
| `output-styles/`, `themes/`, `workflows/` | The formats are unrelated to pi's equivalents |
| `userConfig` and `${user_config.*}` | Needs a settings UI and a credential store |
| `http`, `mcp_tool`, `prompt` and `agent` hook handlers | Only `command` handlers are executed; the rest are reported |
| Hook events outside the six above | No pi counterpart; each one is named in the startup report |

Everything refused or unsupported is listed at startup, never silently ignored.

## Security

Every plugin component runs with your privileges. Two of them are code you never typed:

- **hooks** run automatically on tool calls, prompts and session events;
- **`` !`command` `` expansions** run when you invoke a command.

Both are **off by default**. Skills, commands, agents and MCP servers load by default: a skill is
text the model may act on, a command runs only when you type it, an agent runs only when the model
calls the tool, and an MCP server is a configuration your adapter decides to connect.

Enable per plugin with `trustedPlugins`, or globally with `allowHooks` / `allowShellCommands`. A
`!` expansion that is not permitted is replaced with a marker, so the command still runs with less
context instead of failing.

Component paths that resolve outside the plugin directory, symlinks included, are rejected. Only
that component is dropped; the plugin still loads.

## Development

```bash
npm install
npm run check   # biome, tsc --noEmit, vitest
```

`docs/design.md` records the mapping decisions and the alternatives that were rejected.

## Licence

MIT
