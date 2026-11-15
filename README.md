# ahub — the Agenteca CLI

`ahub` installs and updates AI agent packages (skills, agents, commands, hooks, MCP servers) from git repositories, and makes them available in **Claude Code**, **Codex**, **GitHub Copilot** and **Cursor**.

The package format is **OpenAPM** (`apm.yml`, `apm.lock.yaml`): a project managed by `ahub` stays readable by the `apm` tool, and the other way round.

> Status: 0.1.0, not yet published on npm. Until it is, the installation command below does not work: build the CLI from source (see "Development").

```bash
npm install -g @agenteca/cli
```

## In two minutes

```bash
ahub add acme/code-review@v1.2.0 --tool claude,cursor
```

`ahub` resolves the version, reads the package, scans it, then **shows everything that will be written** — files, hooks, MCP servers — and asks for confirmation. Nothing is written before that.

| Command | Purpose |
|---|---|
| `ahub init` | Creates `apm.yml`. |
| `ahub add <package…>` | Adds and installs. Accepts `owner/repo`, `…@tag`, `…#ref`, a git URL, a local path, or `name@registry`. |
| `ahub install` | Installs what the manifest describes, replaying the lockfile. `--frozen` for CI. |
| `ahub list` | Installed packages. |
| `ahub outdated` | Available updates. |
| `ahub update [package…]` | Updates, within the ranges of the manifest. |
| `ahub remove <package…>` | Removes the package and all its files. |
| `ahub search [terms]` | Searches the registries. |
| `ahub info <package>` | Shows the content of a package without installing it (`--files` for the text). |
| `ahub scan [target]` | Security scan; `--format sarif` for GitHub code scanning. |
| `ahub registry add\|list\|remove\|export` | Manages registries; `export` produces a native `marketplace.json`. |

Common options: `--tool` (or `--target`), `--global`, `--json`, `--yes`, `--dry-run`, `--cwd`, `--lang`.

`owner/repo@tag` is a convenience of the command line: the manifest always receives the OpenAPM form `owner/repo#tag`.

## Safeguards

- **Security scan.** A critical finding (invisible Unicode characters, `curl … | sh`) blocks the installation. Explicit override: `--allow-unsafe`.
- **Files edited by hand.** `ahub` never overwrites or deletes them without agreement: it asks file by file in a terminal; otherwise use `--overwrite <path>` or `--force`.
- **No script is run** at installation.
- **Outside a terminal**, nothing is applied without `--yes`.

## Languages

Messages and help are available in English, French, Spanish, Chinese and Hindi. The language comes from, in order:

1. `--lang <code>` (`en`, `fr`, `es`, `zh`, `hi`);
2. the `AHUB_LANG` variable;
3. `LC_ALL`, `LC_MESSAGES`, then `LANG` (`fr_FR.UTF-8` → French);
4. English otherwise.

```bash
ahub list --lang es
```

Error codes, JSON field names and the content of the files written never change with the language. Messages are translated in `src/locales/` (and in `@agenteca/core` for the library's own messages); `test/i18n.test.ts` fails when a translation is missing.

## `--json` output: the contract

Every integration (MCP server, VS Code and JetBrains extensions, plugins) drives `ahub --json`. This output is a versioned contract, described by [`schemas/cli-output.v1.schema.json`](schemas/cli-output.v1.schema.json) and checked by the tests on every command.

```json
{
  "schemaVersion": "1.0",
  "command": "add",
  "ok": true,
  "data": {},
  "warnings": [{ "code": "HOOK_EVENT_UNSUPPORTED", "message": "…" }],
  "error": null
}
```

- With `--json`, `ahub` never asks a question and writes nothing to standard error.
- `error` is `null` or `{ code, message, details }`. Codes are stable: `CONFIRMATION_REQUIRED`, `PLAN_CHANGED`, `SCAN_BLOCKED`, `FILE_MODIFIED`, `NOT_FOUND`, `RESOLUTION_FAILED`, `LOCK_MISMATCH`, `NO_TARGET`, `USAGE`… Messages follow the language; codes do not.
- **Versioning policy.** Adding a field or a command increments the minor version (`1.x`). Removing a field or changing its meaning increments the major version and renames the schema file. Ignore the fields you do not know.
- **Exception.** `ahub scan --format sarif` writes a raw SARIF 2.1.0 document, not the envelope.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error |
| 2 | Usage error, or no target tool |
| 3 | Refused by the security scan (also: `ahub scan` with a critical finding) |
| 4 | Confirmation required, or plan changed since it was approved |
| 5 | File edited by hand |

### Two-step installation

For an interface that must show the plan before acting:

```bash
ahub add acme/code-review --tool claude --dry-run --json
```

The answer contains the plan (`files`, `configFiles`, `executables`, `scan`) and a `planHash`. Once the user has agreed:

```bash
ahub add acme/code-review --tool claude --yes --expect-plan <planHash> --json
```

If the content changed in between, `ahub` refuses (`PLAN_CHANGED`): what is applied is exactly what was shown.

### TypeScript client

```ts
import { AhubClient } from '@agenteca/cli/client';

const ahub = new AhubClient({ cwd: projectDir });
const plan = await ahub.plan('add', ['acme/code-review'], { tools: ['claude'] });
if (plan.ok) await ahub.apply('add', ['acme/code-review'], plan.data.planHash, { tools: ['claude'] });
```

The client has no dependency: it runs the binary and reads the envelope. Pass `env: { ...process.env, AHUB_LANG: 'fr' }` to get messages in another language.

## Registries

A registry is a catalog of packages. Three forms are accepted:

```bash
ahub registry add https://catalog.example.org
```

```bash
ahub registry add agenteca/agenteca-registry
```

```bash
ahub registry add ./my-catalog
```

A repository or a folder serves as a registry if it contains an `apm.yml` with a `marketplace:` block, or a `marketplace.json` in the Claude Code, Copilot CLI, Codex or Cursor format.

The list of registries is the only file specific to `ahub`: `~/.config/ahub/config.json`.

## Interoperability with `apm`

Checked against `apm` 0.35.0, in both directions: `apm install` accepts a project installed by `ahub`, and `ahub` reads and replays a project installed by `apm`.

- Automated (`test/interop.test.ts`, enabled by `AHUB_INTEROP_APM`): a local package, offline.
- Tried by hand on 14 November 2026: a package in a subfolder of a public GitHub repository, with a hook and an MCP server.

To get there, `ahub` writes three details the specification leaves open the way `apm` does: `repo_url: _local/<folder>` for a local package, the `mcp_target_servers` field, and `"type": "stdio"` in `.mcp.json`. It also reads `apm`'s identity form (`repo_url` without the host, `host` separately).

Limits observed:

- The two tools do not write the same file for a Claude Code agent or command (`ahub` adds the `name:` field that the Claude Code documentation requires). Alternating between the two tools therefore rewrites these files every time.
- Hooks are not handled the same way: `apm` records them in `.claude/apm-hooks.json`, `ahub` in the lockfile. A hook added by one is not removed by the other.
- `apm` keeps a `deployments:` register in the lockfile; `ahub` keeps it without updating it.
- `apm` does not keep the `x-ahub` extension: after an `apm install`, `ahub` no longer knows which configuration entries it had merged.

In practice: both tools read the same project, but pick one to install and remove.

## Development

The `agenteca-*` repositories are developed side by side in an npm workspace: `@agenteca/core` must be built first.

```bash
npm install
```

```bash
npm test
```

In CI, `agenteca-core` is cloned next to this repository and linked through an npm workspace: no published package is needed.

## License

Apache-2.0.
