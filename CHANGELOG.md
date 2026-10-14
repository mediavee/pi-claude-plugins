# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `SessionStart` context is not sent again when the same text is still in the active context, so a
  session resumed many times no longer stacks a copy per resume.
- `SessionStart` hooks run again after a compaction, with source `compact`, as upstream: the summary
  had dropped their context until the next session start.

## [0.1.0] - 2026-09-05

### Added

- Load Claude Code plugins from directories (`claudePlugins.paths`, `PI_CLAUDE_PLUGINS`) and from
  local marketplace checkouts (`claudePlugins.marketplaces` + `enabledPlugins`). Plugin identity
  is origin-qualified (`name@marketplace`) for every trust decision.
- Plugin skills registered through pi's `resources_discover`; skills using `${CLAUDE_*}` are
  served from a per-session mirror; skill-name collisions are reported.
- Plugin commands registered as `/{plugin}:{command}`, with Claude Code's zero-based `$N`,
  `$ARGUMENTS[N]`, named `$name` arguments, `` !`command` `` expansion, `@path` references and the
  `ARGUMENTS:` fallback. Shell and file references are lifted from the authored body before
  arguments are substituted, so arguments cannot inject either.
- Plugin agents exposed through a `claude_plugin_agent` tool that runs each agent in a child `pi`
  process, mapping Claude tool names onto pi's and refusing restrictions pi cannot honour.
- Plugin hooks bridged to pi events for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
  `SessionStart` and `PreCompact`, honouring the upstream stdin JSON, exit-code and JSON-output
  protocol, `if` filters and `shell` selection. Decisions fail closed: `ask` prompts (and denies
  without a UI), `defer` denies, `continue: false` stops the run.
- MCP servers from `.mcp.json` registered with `pi-mcp-adapter` at runtime, with `${CLAUDE_*}`
  and `${VAR:-default}` expansion.
- Startup report listing what loaded, what was refused and what is unsupported, plus a
  `/claude-plugins` command to show it again.
- Hooks and shell expansion default to off, with per-plugin (`trustedPlugins`) and global opt-in.

[Unreleased]: https://github.com/mediavee/pi-claude-plugins/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mediavee/pi-claude-plugins/releases/tag/v0.1.0
