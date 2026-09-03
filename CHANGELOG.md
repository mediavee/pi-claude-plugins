# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Command arguments can no longer inject shell commands or file reads: `` !`command` `` and
  `@path` are lifted from the authored body before arguments are substituted, and placeholders
  resolve in one pass.
- Command prose expands only `${CLAUDE_*}`, so a plugin cannot copy an environment secret into
  the prompt; generic `${VAR}` expansion stays confined to MCP configuration.
- `@path` reads are confined to the project and the plugin directory.
- Hook decisions fail closed: `permissionDecision: "ask"` prompts and denies where there is no
  UI, `"defer"` is denied, and exit code 2 blocks whatever the hook also printed.
- Marketplace entries load only when `enabledPlugins` names them; adding a catalog installs
  nothing.
- Plugin identity is origin-qualified as `name@marketplace`, so a marketplace entry cannot
  inherit another plugin's hook trust by reusing its bare name.
- Agents declaring `isolation`, `maxTurns`, `memory`, `skills`, `background`, or a tool list
  with no pi equivalent are refused instead of running with wider access; `disallowedTools` is
  honoured.
- Hook file paths reach hooks absolute, so a path policy cannot be dodged by a relative spelling.

### Added

- Hook handler `if` filters and `shell: bash | powershell` selection.
- `updatedToolOutput` / `updatedMCPToolOutput` on `PostToolUse`.
- Plain hook stdout is added to context on `UserPromptSubmit` and `SessionStart`.
- `last_assistant_message` on `Stop` input.
- Inline `hooks` and `mcpServers` manifest values are accepted with or without their file
  wrapper.
- Skills whose body uses `${CLAUDE_*}` are served from a rewritten mirror that keeps siblings
  reachable.
- `enabledPlugins` setting and `PI_CLAUDE_PLUGINS_ENABLED` environment override.

### Fixed

- `continue: false` stops the run instead of steering it, including on `Stop`.
- `PostToolUse` no longer fires for denied or failed calls, and receives structured `details`.
- A plugin-root `SKILL.md` loads only for a single-skill plugin and is containment-checked.
- A malformed manifest is rejected with a diagnostic instead of aborting discovery for the
  plugins behind it; unparseable hook and MCP config files are reported rather than silently
  treated as empty policy.
- `trustedPlugins` grants shell expansion in commands, as the configuration contract promises.
- Marketplace sources containing `..` are rejected.
- Hook and command subprocesses escalate to SIGKILL, cap their output, and honour cancellation.
- Plugin commands await the turn they generate and queue correctly while the agent is streaming.

## [0.1.0]

### Added

- Load Claude Code plugins from directories (`claudePlugins.paths`, `PI_CLAUDE_PLUGINS`) and from
  local marketplace checkouts (`claudePlugins.marketplaces`).
- Plugin skills registered through pi's `resources_discover`, with skill-name collisions reported.
- Plugin commands registered as `/{plugin}:{command}`, with Claude Code's zero-based `$N`,
  `$ARGUMENTS[N]`, named `$name` arguments, `` !`command` `` expansion and `@path` references.
- Plugin agents exposed through a `claude_plugin_agent` tool that runs each agent in a child `pi`
  process, mapping Claude tool names onto pi's.
- Plugin hooks bridged to pi events for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
  `SessionStart` and `PreCompact`, honouring the upstream exit-code and JSON output protocol.
- MCP servers from `.mcp.json` registered with `pi-mcp-adapter` at runtime.
- Startup report listing what loaded, what was refused and what is unsupported, plus a
  `/claude-plugins` command to show it again.
- Hooks and shell expansion default to off, with per-plugin (`trustedPlugins`) and global opt-in.

[Unreleased]: https://github.com/mediavee/pi-claude-plugins/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mediavee/pi-claude-plugins/releases/tag/v0.1.0
