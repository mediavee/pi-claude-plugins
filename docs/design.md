# Design

`pi-claude-plugins` loads Claude Code plugins into a [pi](https://pi.dev) session. This
document records what was verified against both upstreams, the mapping decisions, the
alternatives that were rejected, and the security model.

Everything below was checked against:

- Claude Code docs: `plugins`, `plugins-reference`, `plugin-marketplaces`, `hooks`, `skills`, `mcp`
  (fetched from `code.claude.com/docs/en/<page>.md`).
- pi `0.84.4` docs shipped in `node_modules/@earendil-works/pi-coding-agent/docs/`:
  `extensions.md`, `skills.md`, `prompt-templates.md`, `packages.md`, `rpc.md`, `settings.md`,
  `custom-provider.md`, plus `examples/extensions/{subagent,dynamic-resources}`.
- `pi-mcp-adapter@2.32.1` (`index.ts`, `types.ts`) for the runtime-registration contract.

## 1. What a Claude Code plugin is

A plugin is a directory holding an optional `.claude-plugin/plugin.json` manifest plus any of:

| Path | Contents |
| --- | --- |
| `skills/<name>/SKILL.md` | Agent Skills, model-invoked and user-invocable |
| `SKILL.md` at plugin root | Single-skill plugin |
| `commands/*.md` | Skills as flat Markdown files (legacy layout, still supported) |
| `agents/*.md` | Sub-agent definitions; frontmatter + system-prompt body |
| `hooks/hooks.json` | Lifecycle hooks |
| `.mcp.json` | MCP servers |
| `.lsp.json`, `monitors/`, `bin/`, `settings.json`, `themes/`, `workflows/`, `output-styles/` | Other component types |

The manifest may redirect component paths. The rules differ per key and are easy to get
wrong, so they are implemented literally:

- `skills` **adds to** the default `skills/` scan.
- `commands`, `agents`, `workflows`, `outputStyles`, `experimental.themes`,
  `experimental.monitors` **replace** their default directory.
- `hooks`, `mcpServers`, `lspServers` accept a path, an array of paths, or an inline object.
- All paths are relative to the plugin root and must start with `./`; `skills` also accepts
  `"."`. Any path resolving outside the plugin root is rejected (`path escapes plugin directory`)
  and only that component is dropped — the plugin still loads.

`${CLAUDE_PLUGIN_ROOT}` is the absolute plugin directory, `${CLAUDE_PROJECT_DIR}` the project
root, `${CLAUDE_PLUGIN_DATA}` a persistent per-plugin directory. They are substituted inline
per component (skill/agent content, hook and monitor commands, MCP `command`/`args`/`env` for
stdio and `url`/`headers` for http) and exported as environment variables to every subprocess.

A marketplace is a repo with `.claude-plugin/marketplace.json`: `name`, `owner`, `plugins[]`,
each entry with a `name` and a `source`. Sources can be a relative path inside the marketplace,
or `github`/`git`/`git-subdir`/`url`/`npm`/`command` objects.

## 2. Mapping to pi

### 2.1 Skills → `resources_discover.skillPaths`

pi fires `resources_discover` after `session_start` and lets an extension return
`{ skillPaths, promptPaths, themePaths }`. `examples/extensions/dynamic-resources/index.ts`
confirms both directories and individual `SKILL.md` file paths are accepted.

**Decision: hand pi the plugin's own skill directories, unmodified.**

pi implements the same Agent Skills standard, discovers `SKILL.md` directories recursively, and
— unlike the standard — does not require the frontmatter `name` to match the parent directory.
So a Claude plugin's `skills/` tree loads as-is. Passing the real directories keeps relative
links (`references/API.md`), bundled scripts, and `${CLAUDE_SKILL_DIR}`-style layouts working.

*Rejected: materialising a staging directory with rewritten frontmatter* to reproduce Claude's
`plugin-name:skill-name` namespacing. pi skill names are constrained to `[a-z0-9-]`, so the
colon form is not expressible; the best approximation would be `plugin-skill`, which breaks the
skill's own documented invocation name for no benefit. Copying also breaks relative asset paths
unless every file is symlinked, and the copies go stale when the plugin updates.

Consequence: two plugins shipping a skill with the same `name` collide. pi warns and keeps the
first one found. We detect the collision ourselves during discovery and report it in the load
report so the user sees *which* plugins collided, not just that something did.

`--skill` is not used: `resources_discover` covers both the TUI and headless paths and needs no
CLI wiring, which matters because the target deployment is `pi --mode rpc`.

### 2.2 Commands → `pi.registerCommand()`

Claude's `commands/*.md` are Markdown with frontmatter, and their bodies support:

- `$ARGUMENTS` — all arguments joined.
- `$ARGUMENTS[N]` / `$N` — **0-based** positional access (`$0` is the first argument).
- `$name` — named arguments declared in the `arguments` frontmatter key, mapped by position.
- `` !`command` `` — shell injection; the command runs before the content reaches the model and
  its output replaces the placeholder.
- `@path` — file reference; the referenced file is attached.
- `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.
- If no placeholder consumed the arguments, `ARGUMENTS: <value>` is appended to the content.

pi prompt templates support `$ARGUMENTS`/`$@`, `${1:-default}`, `${@:N:L}` and **1-based** `$1`.
The index bases are in direct conflict: `$1` means "first argument" to pi and "second argument"
to Claude. Neither `!` nor `@` exists in pi templates.

**Decision: register one pi command per plugin command via `pi.registerCommand()` and do the
expansion ourselves**, then hand the result to `pi.sendUserMessage(expanded)`.

Command name is `<plugin>:<command>`, matching Claude's namespacing — pi already ships
colon-bearing command names (`/skill:name`), and `pi.getCommands()` / the RPC `get_commands`
response list extension commands first, so they are reachable from the TUI and from
`{"type":"prompt","message":"/plugin:cmd args"}` in RPC mode.

*Rejected: emitting translated `.md` files into a temp directory exposed through
`resources_discover.promptPaths`.* It cannot express `$0`-based indices without rewriting every
placeholder (silently changing user-authored content), cannot express `!` or `@` at all, and
adds a temp-file lifecycle for zero gain. Registering commands also gives us a place to enforce
the shell-execution opt-in per plugin, which a static template file cannot do.

`SKILL.md` files with `disable-model-invocation` are *not* additionally registered as commands:
pi already exposes every loaded skill as `/skill:<name>` (`enableSkillCommands`, default `true`).
Only `commands/*.md` become extension commands.

### 2.3 Agents → an extension-owned subagent tool

**Decision: register a `claude_plugin_agent` tool that spawns a child `pi` process.**

This mirrors pi's own `examples/extensions/subagent`, which is the reference implementation for
delegation in pi and the only approach the pi runtime actually supports for isolated context.
The invocation follows that example:

```
pi --mode json -p --no-session [--model M] [--thinking L] [--tools a,b] \
   --append-system-prompt <tmpfile> "Task: …"
```

`process.argv[1]` is preferred over a bare `pi` on `PATH` so the child is the same build as the
parent, falling back to `pi` when the parent runs from a bundled binary.

Claude tool names in `tools` / `disallowedTools` frontmatter are mapped to pi's:

| Claude | pi |
| --- | --- |
| `Read` | `read` |
| `Write` | `write` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit` |
| `Bash` | `bash` |
| `Glob` | `find` |
| `Grep` | `grep` |
| `LS` | `ls` |
| `Task`, `Agent` | *(dropped — no pi equivalent)* |

Unmapped names are dropped and reported rather than passed through, because `--tools` with an
unknown name would fail the whole child process.

*Rejected: emitting agent files for `pi-subagents` when that package is present.* The brief
requires the standalone path to work without it, so the spawn tool must exist anyway; adding a
second code path that only runs when another package happens to be installed doubles the
surface for no capability we lack. `pi-subagents` registers its own tools under its own names,
so the two coexist without conflict — a user who prefers it can simply not enable our agents.

Claude's `hooks`, `mcpServers` and `permissionMode` agent frontmatter keys are refused for
plugin-shipped agents upstream, and we refuse them too.

### 2.4 Hooks → pi events

| Claude event | pi event | Capability used |
| --- | --- | --- |
| `PreToolUse` | `tool_call` | `{ block, reason, terminate }`; mutate `event.input` in place |
| `PostToolUse` | `tool_result` | return a patch `{ content, isError }` |
| `UserPromptSubmit` | `before_agent_start` | return `{ message }` to inject context |
| `Stop` | `agent_end` | notification only |
| `SessionStart` | `session_start` | inject context on the next turn |
| `PreCompact` | `session_before_compact` | return `{ cancel: true }` |

Every other Claude hook event (`PostToolUseFailure`, `Notification`, `SubagentStart`,
`PermissionRequest`, `FileChanged`, `SessionEnd`, …) has no pi counterpart and is reported as
unsupported at load time rather than silently ignored.

**Handler types.** Only `type: "command"` is executed. `http`, `mcp_tool`, `prompt` and `agent`
handlers are counted and reported as unsupported: `prompt`/`agent` require a hook-scoped model
call with Claude's own decision schema, and `http`/`mcp_tool` would need an allowlist policy
that belongs to the host, not to a plugin loader.

**Wire format.** Handlers receive Claude's JSON shape on stdin:

```json
{"session_id":"…","cwd":"…","hook_event_name":"PreToolUse","tool_name":"Bash",
 "tool_input":{"command":"…"},"tool_use_id":"…","permission_mode":"default"}
```

`tool_name` is the *Claude* name (reverse of the table in §2.3) so that matchers written for
Claude Code fire in pi. `tool_input` is translated per tool where the shapes differ — pi's
`find` takes `pattern`, Claude's `Glob` takes `pattern` + `path`; pi's `read` takes `path`,
Claude's `Read` takes `file_path`. Translation is bidirectional: an `updatedInput` coming back
from a hook is mapped to pi's shape before being written onto `event.input`.

`PostToolUse` adds `tool_response`; `UserPromptSubmit` adds `prompt`; `SessionStart` adds
`source`; `PreCompact` adds `trigger` and `custom_instructions`. Beyond the path rename, `Edit`
keeps pi's `edits[]` array rather than Claude's `old_string`/`new_string`: the two edit models are
not equivalent, and inventing a lossy translation would silently corrupt an `updatedInput`.

A call denied by a `PreToolUse` hook never reaches `PostToolUse`, matching upstream, where that
event only fires for a tool that ran.

**Matchers** are regular expressions tested with `RegExp.prototype.test` (unanchored), plus the
exact-match set form (`Write|Edit`, or a comma-separated list). `"*"` and an absent matcher both
match everything. This matches Claude's documented behaviour, including the consequence that
`Edit.*` also matches `NotebookEdit`.

**Exit codes and JSON**, per the upstream protocol:

- exit `0`, stdout starting `{` and ending `}` → parsed as the JSON output object.
- exit `2` → block; the reason is the JSON blocking decision when present, otherwise stderr.
- any other exit code → non-blocking error; the action proceeds and a warning is surfaced.
  Valid JSON on a non-zero, non-2 exit is still honoured.

Honoured JSON fields: `continue` / `stopReason` (universal, blocks the action),
top-level `decision` + `reason` (`UserPromptSubmit`, `PostToolUse`, `PreCompact`), and
`hookSpecificOutput.{permissionDecision, permissionDecisionReason, updatedInput, additionalContext}`
for `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`. `permissionDecision: "ask"` is
downgraded to allow-with-warning because pi's `tool_call` has no "prompt the user" return;
`"defer"` is refused (it only exists for `claude -p` resumption).

When several handlers match one event, precedence is `deny` > `ask` > `allow`, and
`updatedInput` from earlier handlers is visible to later ones — the same chaining pi already
gives `tool_call` handlers.

Handlers get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` in their
environment, run with `cwd` = the session cwd, and are cancelled at `timeout` (default 600 s,
30 s on `UserPromptSubmit`, matching upstream). A cancelled handler renders no decision.

Prior art reviewed but not copied: [`hsingjui/pi-hooks`](https://github.com/hsingjui/pi-hooks).

### 2.5 MCP servers → `pi-mcp-adapter` runtime registration

Verified against `pi-mcp-adapter@2.32.1` `index.ts`: the adapter installs a listener on the
shared bus for `"pi-mcp-adapter:runtime-register:v1"` and writes `request.result` **synchronously**;
the first listener to respond wins, and a request that already carries a `result` is ignored.

```ts
const request = { version: 1, name, definition };
pi.events.emit("pi-mcp-adapter:runtime-register:v1", request);
if (!request.result) { /* adapter not installed */ }
```

`definition` is the adapter's `ServerEntry`, whose `command`/`args`/`env`/`cwd`/`url`/`headers`
fields line up with Claude's `.mcp.json` entries. We register during `session_start` (the
adapter's listener is installed by then) and `dispose()` every registration in
`session_shutdown`, as its README instructs.

Server names are prefixed `<plugin>__<server>`, matching the adapter's own convention for
plugin-provided servers and avoiding collisions with user-configured servers — the adapter
fails closed on duplicate names.

`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}` and Claude's
`${VAR}` / `${VAR:-default}` environment expansion are resolved by us across `command`, `args`,
`env`, `url` and `headers`, then `literalEnv: true` is set so the adapter does not re-expand
values we already resolved. A `${VAR}` with no value and no default is left as literal text and
warned about, exactly as Claude Code does.

Without `pi-mcp-adapter` loaded, MCP servers are skipped with one clear warning naming the
servers and the package needed. We do not implement an MCP client: that is a whole subsystem
and a well-maintained pi package already owns it.

### 2.6 Not supported, and why

| Claude feature | Status |
| --- | --- |
| `.lsp.json` | pi has no LSP integration point for extensions |
| `monitors/monitors.json` | No pi event delivers background stdout as a notification |
| `bin/` on `PATH` | pi's bash tool has no per-extension `PATH` injection hook |
| plugin `settings.json` (`agent`, `subagentStatusLine`) | Would repoint the *main* thread's system prompt; too invasive for a loader |
| `output-styles/`, `themes/`, `workflows/` | Formats are unrelated to pi's equivalents |
| `userConfig` / `${user_config.*}` | Requires a settings UI and a credential store |
| root `CLAUDE.md` | Not part of the plugin contract upstream either |
| `$CLAUDE_PLUGIN_OPTION_*` in hooks | Follows `userConfig` |

## 3. Configuration

Read from pi's `settings.json` under a single namespaced key. `ExtensionContext` exposes no
settings accessor in 0.84.4 (checked: `dist/core/extensions/types.d.ts`), and the `Settings`
interface has no index signature, so the files are read directly — global
`~/.pi/agent/settings.json` first, then project `.pi/settings.json` merged over it, and the
project file is only read when `ctx.isProjectTrusted()`.

```json
{
  "claudePlugins": {
    "paths": ["~/plugins/acme-tools"],
    "marketplaces": ["~/marketplaces/acme"],
    "allowShellCommands": false,
    "allowHooks": false,
    "trustedPlugins": ["acme-tools"],
    "disabledPlugins": [],
    "agents": true
  }
}
```

Environment overrides, for headless and container use:

| Variable | Effect |
| --- | --- |
| `PI_CLAUDE_PLUGINS` | `PATH`-separated plugin directories, appended to `paths` |
| `PI_CLAUDE_PLUGINS_MARKETPLACES` | `PATH`-separated marketplace directories |
| `PI_CLAUDE_PLUGINS_ALLOW_HOOKS` | `1`/`true` sets `allowHooks` |
| `PI_CLAUDE_PLUGINS_ALLOW_SHELL` | `1`/`true` sets `allowShellCommands` |

## 4. Security model

Every plugin component runs with the user's privileges. Two of them are arbitrary code the user
never typed:

- **hooks** — shell commands that run automatically on tool calls and prompts;
- **`` !`command` `` expansions** in commands — shell commands that run when a command is invoked.

Both default to **off**. Skills, commands, agents and MCP servers load by default: a skill is
text the model may act on, a command runs only when the user types it, an agent runs only when
the model calls the tool, and an MCP server is a config the user's adapter decides to connect.
Hooks and `!` are different in kind — they execute without any per-invocation decision.

Enabling is per-plugin (`trustedPlugins`) or global (`allowHooks` / `allowShellCommands`).
A `!` expansion that is not permitted is replaced with
`[shell command execution disabled by pi-claude-plugins]`, which is what Claude Code's own
`disableSkillShellExecution` policy does, so the command still runs with degraded context
rather than failing.

Path traversal is rejected for every component path, matching upstream. Symlinks resolving
outside the plugin root are skipped.

At `session_start` the extension logs one report: plugins loaded with their component counts,
components refused with the reason, unsupported hook events and handler types, skill-name
collisions, and MCP servers skipped for want of `pi-mcp-adapter`.

## 5. Module layout

Small, single-concept modules, one per Claude plugin concept, plus discovery:

```
src/
  index.ts        extension entry: wires modules to pi events
  config.ts       settings + env resolution, trust decisions
  manifest.ts     plugin.json parsing, component path resolution, traversal guard
  discovery.ts    plugin discovery from paths and marketplaces
  marketplace.ts  marketplace.json parsing and local source resolution
  substitute.ts   ${CLAUDE_*} and ${VAR:-default} expansion
  tool-names.ts   Claude <-> pi tool name and input-shape mapping
  skills.ts       skill directory resolution
  commands.ts     command parsing and expansion
  agents.ts       agent parsing and the subagent tool
  hooks.ts        hooks.json parsing, matching, execution, decision merging
  mcp.ts          .mcp.json parsing and adapter registration
  report.ts       the session_start load report
  types.ts        shared types
```

Marketplace sources: only local relative paths are resolved. Remote sources (`github`, `git`,
`url`, `npm`, `command`) are reported as unresolved — cloning and caching remote plugin sources
duplicates what `pi install git:…` already does, and a plugin loader that shells out to `git`
on startup is a supply-chain surface we decline to add. Point `marketplaces` at a checkout.

## 6. Testing

- **Unit tests** (vitest) per module: manifest parsing and path-escape rejection, substitution,
  argument expansion including the 0-based `$N`, matcher semantics, exit-code and JSON decision
  handling, tool-name mapping round-trips.
- **A fixture plugin** at `test/fixtures/` exercising every supported component.
- **An end-to-end test** spawning `pi --mode rpc -e ./src/index.ts` with a second `-e`
  extension that registers a faux provider. `pi.registerProvider(name, { streamSimple })`
  accepts a stream function directly (`docs/custom-provider.md`), and
  `@earendil-works/pi-ai` exports `createFauxCore()` / `fauxAssistantMessage()` /
  `fauxToolCall()`, so the child process gets scripted model responses with no network. The
  test drives JSONL commands over stdin and asserts that a command expands, that a hook blocks
  a tool call, and that an agent runs.
