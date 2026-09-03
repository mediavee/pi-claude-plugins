# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
