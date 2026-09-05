# pi-claude-plugins

Load [Claude Code plugins](https://code.claude.com/docs/en/plugins) natively into
[pi](https://pi.dev). Point the extension at a plugin directory or a marketplace checkout and the
plugin's skills, commands, agents, hooks and MCP servers become available in the pi session, with
the semantics a Claude Code user expects.

Works the same in the TUI and headless (`pi --mode rpc`, `pi --mode json`, `pi -p`).

## Install

```bash
pi install npm:@mediavee/pi-claude-plugins
```

Or try it for one run without installing:

```bash
pi -e npm:@mediavee/pi-claude-plugins
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
    "enabledPlugins": ["formatter@acme"],
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
| `enabledPlugins` | `[]` | Marketplace entries to load, as `name@marketplace` |
| `allowHooks` | `false` | Run hooks from every plugin |
| `allowShellCommands` | `false` | Run `` !`command` `` expansions in plugin commands |
| `trustedPlugins` | `[]` | Grant both of the above to named plugins only |
| `disabledPlugins` | `[]` | Skip these plugins entirely |
| `agents` | `true` | Register the subagent tool for plugin agents |

A plugin's identity is origin-qualified: a directory from `paths` is known by its manifest name,
and a marketplace entry by `name@marketplace`. `enabledPlugins`, `trustedPlugins` and
`disabledPlugins` all match that identity, so one marketplace cannot inherit another plugin's
grants by reusing its name.

For headless and container use, the environment wins over settings:

| Variable | Effect |
| --- | --- |
| `PI_CLAUDE_PLUGINS` | `PATH`-separated plugin directories, appended to `paths` |
| `PI_CLAUDE_PLUGINS_MARKETPLACES` | `PATH`-separated marketplace directories |
| `PI_CLAUDE_PLUGINS_ENABLED` | Comma-separated marketplace entries to enable |
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
`/skill:<name>`. A `SKILL.md` at the plugin root loads only when the plugin ships no `skills/`
directory and declares no manifest `skills` field, as upstream.

pi does not understand `${CLAUDE_*}` placeholders. A skill whose body uses one is served from a
mirror directory where the siblings are symlinked and only `SKILL.md` is rewritten, so bundled
script paths resolve while relative links keep working.

Claude Code namespaces plugin skills as `/plugin:skill`. pi skill names are limited to
`[a-z0-9-]`, so the colon form cannot be reproduced and skills keep their own names. If two
plugins ship a skill with the same name, pi keeps the first and this extension names both
offenders in the startup report.

### Commands

Command bodies get the full Claude Code treatment:

- `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` — **zero-based**, so `$0` is the first argument, matching
  Claude Code rather than pi's one-based prompt templates.
- `$name` for arguments declared in the `arguments` frontmatter key.
- `` !`command` `` and ` ```! ` blocks, gated behind `allowShellCommands` or `trustedPlugins`.
- `@path` file references.
- `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`.

When no placeholder consumes the arguments, they are appended as `ARGUMENTS: <value>`, as upstream.

Shell commands and `@path` references are read from the authored command file **before** any
argument is substituted, and every placeholder is resolved in a single pass. Text an argument
brings in is therefore never rescanned, so an argument cannot smuggle in a command to run or a
file to read.

Two deliberate restrictions:

- Only `${CLAUDE_*}` placeholders expand in command prose. Generic `${VAR}` expansion is
  confined to MCP configuration, as upstream, so a command body cannot copy an environment
  secret into the prompt.
- `@path` reads are confined to the project directory and the plugin directory. Claude Code
  subjects them to its Read permission rules, which pi has no equivalent of; a reference outside
  both is replaced with a marker. The contents are inlined in a labelled code fence rather than
  attached, because pi has no attachment channel for extension-sent messages.

### Agents

Each `agents/*.md` file becomes an option of one tool, `claude_plugin_agent`, which spawns a child
`pi` with the agent's system prompt, model and tool allowlist and returns its final output. Claude
tool names map onto pi's:

`Read`→`read`, `Write`→`write`, `Edit`/`MultiEdit`/`NotebookEdit`→`edit`, `Bash`→`bash`,
`Glob`→`find`, `Grep`→`grep`, `LS`→`ls`.

Names with no pi equivalent, such as `Task` or `WebFetch`, are dropped and reported rather than
passed through, since an unknown name would fail the child process. `disallowedTools` is
subtracted from the allowlist, or from pi's built-in tools when the agent declares none.

An agent is **not loaded** when it declares a restriction pi cannot honour, rather than running
with more freedom than its author asked for. That covers `isolation`, `maxTurns`, `memory`,
`skills` and `background`, and an agent whose entire `tools` list maps to nothing. `hooks`,
`mcpServers` and `permissionMode` are refused for plugin agents, as they are upstream. `effort`
maps onto pi's thinking level where the names coincide. Everything refused is named at startup.

### Hooks

| Claude event | pi event | What a hook can do |
| --- | --- | --- |
| `PreToolUse` | `tool_call` | Allow, ask, deny, or rewrite the input with `updatedInput` |
| `PostToolUse` | `tool_result` | Append feedback, or replace the output with `updatedToolOutput` |
| `UserPromptSubmit` | `input` | Block the prompt, or inject context |
| `Stop` | `agent_end` | Block to keep the conversation going, capped at 8 continuations |
| `SessionStart` | `session_start` | Inject context for the first turn |
| `PreCompact` | `session_before_compact` | Block compaction |

Handlers receive Claude Code's JSON on stdin, with `tool_name` in Claude's vocabulary so matchers
written upstream keep firing, and with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and
`CLAUDE_PROJECT_DIR` in their environment. Shell-form handlers run under `bash`, as upstream, so
`bash` must be on `PATH`. Exit codes and JSON output follow the upstream
protocol: exit `2` blocks with stderr as the reason whatever the hook also printed, valid JSON on
stdout is honoured on any exit code, and any other non-zero exit is a non-blocking error. When
several hooks match they all run in parallel and their decisions merge with `deny` > `ask` >
`allow`.

Decisions fail closed:

- `permissionDecision: "ask"` shows a confirmation. With no UI — `pi --mode json`, `pi -p` —
  there is nobody to ask, so the call is denied.
- `permissionDecision: "defer"` is denied. It exists to suspend a `claude -p` run for later
  resumption, which pi cannot do; treating it as an allow would turn a pause into an approval.
- `continue: false` stops the run. On `Stop` it ends the turn rather than continuing it.

`UserPromptSubmit` and `SessionStart` also take plain stdout as context, as upstream; on every
other event stdout is diagnostic only.

A handler's `if` rule is evaluated on `PreToolUse` and `PostToolUse`: `Bash(git *)` checks the
command, its `$(…)` and backtick substitutions and its `&&`/`;`/`|` chain with leading `VAR=`
assignments stripped, while `Edit(**/src/**)` checks the path. As upstream the filter is
best-effort and runs the hook when the command is opaque. A handler that declares `if` on any
other event never runs. `shell: "bash" | "powershell"` selects the interpreter.

Matchers use Claude's rules: a matcher of only word characters, spaces, commas and pipes is a list
of exact names, anything else is an unanchored regular expression.

`tool_input` is translated where the shapes differ, so `Read`, `Write`, `Edit` and `LS` report an
**absolute** `file_path` rather than pi's possibly relative `path`, matching Claude Code's
guarantee that a path policy cannot be dodged by spelling the same file relatively. An
`updatedInput` coming back is translated in reverse. Beyond the path, `Edit` keeps pi's `edits[]`
array instead of Claude's `old_string`/`new_string`, so a hook that rewrites edit contents needs
pi's shape.

`PostToolUse` fires only for a call that ran and succeeded, as upstream: a call a `PreToolUse`
hook denied, and a call that failed, are both skipped. `tool_response` carries pi's structured
`details` where the tool provides them, and the rendered content otherwise.

### MCP servers

Servers from `.mcp.json` are registered with `pi-mcp-adapter` at `session_start` and disposed at
`session_shutdown`, under the name `<plugin>__<server>`. `${CLAUDE_*}` placeholders and Claude's
`${VAR}` / `${VAR:-default}` syntax are resolved across `command`, `args`, `env`, `cwd`, `url` and
`headers` before registration.

Without `pi-mcp-adapter` installed, the servers are skipped and named in the startup report.

### Marketplaces

A marketplace is a catalog, not an install: adding one lists what is available, and an entry only
loads once `enabledPlugins` names it. The startup report lists everything available but not
enabled.

Entries are read from a local checkout. A relative `./path` source (or a bare name under
`metadata.pluginRoot`) resolves; any source containing `..` is rejected outright, as upstream,
even when it normalises back inside. `github`, `url`, `git-subdir`, `npm`, `archive` and
`command` sources are reported as unresolved rather than fetched: cloning and caching remote
sources duplicates what `pi install git:…` already does, so point `marketplaces` at a checkout
you manage.

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
| `PostToolUseFailure` | pi has no separate failure event, so failed calls simply skip `PostToolUse` |
| Marketplace `defaultEnabled` and `strict` | Enablement is explicit through `enabledPlugins` |

Everything refused or unsupported is listed at startup, never silently ignored.

Four smaller deviations worth knowing:

- pi dispatches `/plugin:command` before its `input` event fires, so `UserPromptSubmit` hooks do
  not see a typed plugin command, only the prompt it expands into on the next event.

- `${CLAUDE_*}` placeholders are substituted before arguments, so an argument containing one
  reaches the model literally rather than being expanded.
- There is no escape syntax for a literal `$0` or `$ARGUMENTS` in a command body.
- `Stop` hook input carries `last_assistant_message` but not `background_tasks` or
  `session_crons`; pi has no task registry to populate them from, and both arrays are optional
  upstream.

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
that component is dropped; the plugin still loads, and a malformed plugin never stops the ones
behind it from loading.

## Development

```bash
npm install
npm run check   # biome, tsc --noEmit, vitest
```

`docs/design.md` records the mapping decisions and the alternatives that were rejected.

## Licence

MIT
