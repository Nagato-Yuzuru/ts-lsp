# ts-lsp

A Claude Code plugin that gives TypeScript/JavaScript code intelligence on both TypeScript 7 and earlier versions.

TypeScript 7 no longer ships `tsserver.js`, so `typescript-language-server` (the server behind the official
`typescript-lsp` plugin) cannot start on a TS 7 project. TS 7 has its own server, `tsc --lsp --stdio`. This plugin's
launcher picks the right one per project.

## How the server is chosen

The launcher walks up from `$CLAUDE_PROJECT_DIR` to the nearest `node_modules/typescript`:

| Found                  | Server started                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| TypeScript ≥ 7         | the project's `tsc --lsp --stdio`                                              |
| TypeScript ≤ 6         | `typescript-language-server --stdio`, project-local if installed, else on PATH |
| none, global `tsc` ≥ 7 | `tsc --lsp --stdio` from PATH                                                  |
| none, otherwise        | `typescript-language-server --stdio` from PATH                                 |

The choice is logged to stderr (`ts-lsp: … -> …`); `claude --debug` shows it under
`[LSP SERVER plugin:ts-lsp:typescript]`.

### Diagnostics on TS 7

`tsc --lsp` only reports file diagnostics when the client pulls them (`textDocument/diagnostic`), while Claude Code only
consumes pushed `textDocument/publishDiagnostics`. On the TS 7 path the launcher relays the protocol through
`plugin/bin/bridge.ts`, which pulls diagnostics for every open document after each open/change/save and pushes the
result. The TS ≤ 6 path runs the server directly with no relay.

## Install

```sh
claude plugin marketplace add Nagato-Yuzuru/ts-lsp
claude plugin install ts-lsp@ts-lsp
```

Disable `typescript-lsp@claude-plugins-official`: both plugins claim the same file extensions and only one server
starts.

Requirements: Node.js ≥ 22.18 on PATH — the plugin is TypeScript run directly by Node's type stripping, with no
build step. For TS ≤ 6 projects, `typescript-language-server` (`pnpm add -D typescript-language-server` in the
project, or installed globally).

## Development

The sources use only erasable TypeScript syntax (`erasableSyntaxOnly`, `verbatimModuleSyntax`), so Node runs them as
written; `tsc` only type-checks. npm tools are pinned by `pnpm-lock.yaml`; the non-npm tools (prek, jactionlint,
shellcheck) by `mise.toml`.

```sh
pnpm install
prek install # run the checks below on every commit
pnpm check   # tsc + oxlint + oxfmt --check
pnpm fmt     # oxfmt
pnpm test    # end-to-end launcher tests (installs fixtures from the registry)
```

`prek.toml` runs prek's builtin whitespace fixers, `pnpm check`, and jactionlint; CI runs the same hooks with
`prek run --all-files`.

`test/launcher.test.ts` copies `test/fixture` into a temp directory (its path contains a space), installs the
TypeScript version under test there, and drives the launcher over stdio the way Claude Code does: definition,
references, hover, and diagnostics after an edit. Cases: TS 7, TS 6, TS 5, a monorepo subpackage, a global `tsc` 7,
and no TypeScript at all. `TS7_SPEC` overrides the TS 7 version spec.

`tsc` 7.0 itself exits with status 1 and prints `context canceled` after a normal `shutdown`/`exit`; the launcher
passes that status through.

## CI

`.github/workflows/ci.yml` runs on pushes, pull requests, and weekly. Fixture installs float within each major, so the
weekly run is an upstream watch: it catches a new TypeScript, typescript-language-server, or Claude Code release
breaking the plugin. Scheduled and manual runs also test the nightly `typescript@next`.

GitHub disables scheduled workflows after 60 days without repository activity; re-enable it from the Actions tab if
that happens.

## Releasing

Bump `version` in `plugin/.claude-plugin/plugin.json` on every release — installed copies are pinned to it. Run
`claude plugin validate ./` first.
