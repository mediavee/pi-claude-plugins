# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `allowHooks` no longer runs `` !`command` `` expansions. Shell expansion stays behind
  `allowShellCommands` or `trustedPlugins`.
- A command hook with `"async": true` runs in the background. It does not block the action, its
  decision fields are ignored, and `timeout` is not enforced. `additionalContext` and
  `systemMessage` are delivered on a later turn.
- `"onFailure": "block"` treats a missing executable, an exit other than 0 or 2, unparseable
  `{...}` stdout and a timeout like exit 2. It has no effect on `Stop` or on an async hook.
- A Bash `if` pattern that names more than the command runs the hook when the line contains
  `$(…)`, backticks or `$VAR`.
- `${CLAUDE_PLUGIN_DATA}` is one directory for a `name@marketplace` plugin in load-time
  substitution, hook environment and child agent environment.
- `PreCompact` ignores `continue`, so `continue: false` no longer cancels compaction.
- Skills that use `${CLAUDE_*}` are mirrored at a path that depends on their content, not on the
  process, so processes share one system prompt. Nothing is removed at session start or shutdown:
  a leftover directory an agent dir does not let the session delete no longer stops every skill from
  loading, and a mirror that cannot be written leaves the skill listed from its own directory with a
  warning. A mirror with a wrong `SKILL.md` or side link is repaired entry by entry, never deleted.
  `PI_CLAUDE_PLUGINS_STAGING` sets where mirrors are written, `PI_CLAUDE_PLUGINS_INVENTORY` where the
  names of the discovered skills are written.
- `SessionStart` context is not sent again when its latest copy in the active context is the same
  text, so a session resumed many times no longer stacks a copy per resume.
- `SessionStart` hooks run again after a compaction, with source `compact`, as upstream: the summary
  had dropped their context until the next session start.

### Changed

- The startup report names loader limits a loaded plugin can hit: Stop `additionalContext` and the
  continuation count, `UserPromptSubmit` on plugin commands, `CLAUDE_ENV_FILE`, plugin MCP names,
  and PreCompact stdout as summary instructions. pi 0.84.4 cannot pass that stdout to the default
  summarizer.

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
