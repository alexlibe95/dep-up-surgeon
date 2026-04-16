# dep-up-surgeon

Production-oriented CLI that upgrades **npm** dependencies with **`npm install` + validation** after each change, and **rolls back** on failure. It is **framework-agnostic**: grouping and conflict handling come from **registry metadata** and **parsed npm output**, not hardcoded stacks (React, Angular, etc.).

With **`--link-groups auto`** (default) it **clusters** upgrades using a **dependency graph** built from the npm registry (see below) plus optional **`.dep-up-surgeonrc`** `linkedGroups`. Use **`--link-groups none`** for strict one-package-at-a-time behavior.

## Install

```bash
npm install -g dep-up-surgeon
```

Or run locally after cloning:

```bash
npm install
npm run build
npx dep-up-surgeon --help
```

## Usage

From your project root (where `package.json` lives):

```bash
dep-up-surgeon [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Resolve latest versions and print the plan; does not change `package.json` or run installs. |
| `--interactive` | On failure, prompts for next steps (see **Interactive mode**). After the run, optionally bulk-add failed names to `.dep-up-surgeonrc`. |
| `--force` | Keep a version bump even when validation fails; also skips **rollback** when structured conflicts are detected in npm output after a successful exit code (use with care). |
| `--ignore <pkgs>` | Comma-separated package names to skip (merged with `.dep-up-surgeonrc`). |
| `--json` | Machine-readable report on stdout (see **JSON report**). |
| `--fallback-strategy <mode>` | `major-lines` (**default**), `minor-lines`, or `none`. After `@latest` fails, **`major-lines`** tries the best stable version per **major** (e.g. `9.x` → `8.x` → `7.x` …). **`minor-lines`** steps one **`major.minor` line** at a time. If npm output looks like **ESM vs CommonJS** (`ERR_REQUIRE_ESM`), further fallbacks for that package **stop**. `none` only attempts `@latest`. |
| `--link-groups <mode>` | `auto` (**default**) or `none`. **`auto`** builds **linked batches** from the registry graph and optional **`linkedGroups`**. **`none`** upgrades one dependency per step. |

Exit code `1` when any upgrade could not be kept (unless `--force`). Fatal errors also exit `1`.

### What gets scanned

Direct entries in **`dependencies`**, **`devDependencies`**, **`peerDependencies`**, and **`optionalDependencies`** are considered. Non-registry ranges (`workspace:`, `link:`, `file:`, `git:` …) are skipped for upgrades.

### How linked groups are chosen (`--link-groups auto`)

There are **no framework-specific lists**. Groups are derived from your **direct** dependency names and **published** package metadata:

1. **Custom** groups from `.dep-up-surgeonrc` `linkedGroups` are applied **first** (exact package names).
2. For each remaining **registry** dependency, the tool fetches the published manifest (**`pacote`**, cached in-memory for the run) and reads **`peerDependencies`** only. (Runtime **`dependencies`** / **`optionalDependencies`** are **not** used for clustering: they tend to connect unrelated packages through hubs like `typescript`, `eslint`, or `rxjs`, producing one giant batch.)
3. An **undirected edge** is added between two project packages **A** and **B** when **B** appears in **A**’s published **peerDependencies** (and both are direct registry deps in your project). **Connected components** become **one upgrade batch** each (single `package.json` write + one `npm install` + one validation).
4. **`@types/<pkg>`** is linked to **`<pkg>`** when **both** are direct dependencies (types often move with the runtime package).
5. Isolated packages are upgraded **alone** (singleton groups).

**Caveats**

- Packages only batch if the **registry** exposes edges between them. If two packages must move together but are not linked in metadata, add a **`linkedGroups`** entry.
- **SDK-style** tooling (e.g. Expo) may expect **`npx expo install`** for channel alignment; this tool automates semver bumps when the graph is visible to npm.
- **Prerelease / canary**: **`@latest`** may not match your channel — pin or ignore as needed.

**Performance**: manifests are fetched with **bounded concurrency** (parallel batches); responses are **cached** for the duration of the run.

### Interactive mode (`--interactive`)

- **Single package** failures: prompt to continue, pin (ignore) that package, or retry once.
- **Linked group** failures: prompt to **skip the group**, **retry** (same targets; several attempts allowed), **force** (same as `--force` for that batch), or **freeze** (add all packages in the group to `.dep-up-surgeonrc` ignore). Attempts are capped higher when interactive so you can recover without rerunning the whole CLI.

### Conflict detection

After each `npm install`, output is passed through a **generic conflict parser** (regex-based, no hardcoded package names). Lines that only refer to the **root** `package.json` **`name`** (for example npm’s `While resolving: my-app@0.0.0`) are filtered out so they do not appear as fake registry-package conflicts. Structured conflicts are **classified** (e.g. peer mismatch, missing peer, version range, engine, unresolved tree). If **`npm install` exits successfully** but conflicts are still detected in the log, the tool **rolls back** the bump (unless **`--force`**). Failed runs also attach parsed conflicts to the report where possible.

### Why not only “latest”?

`latest` may not be adoptable yet (e.g. **ESM-only** majors, or a **TypeScript** major that breaks your build). The default strategy tries **`@latest` first**, then walks older **release lines** when fallbacks are enabled.

## Configuration

Create `.dep-up-surgeonrc` in the project root:

```json
{
  "ignore": ["some-legacy-package"],
  "linkedGroups": [
    {
      "id": "my-batch",
      "packages": [
        "package-a",
        "package-b"
      ]
    }
  ]
}
```

Ignored packages are never upgraded. The CLI `--ignore` list is merged with this file.

**`linkedGroups`** defines **forced** batches **before** the dynamic graph runs (exact npm package names).

## JSON report (`--json`)

Stdout is a single JSON object including:

- **`upgraded`**, **`skipped`**, **`failed`**, **`conflicts`** (parsed from npm output), **`unresolved`** (failed entries), **`groups`** (planned linked groups: ids and package names), and **`ignored`**.

Use this for CI or tooling that needs structured results.

## Safety

- Before the first real change, the tool copies `package.json` to `package.json.dep-up-surgeon.bak`.
- On uncaught errors, it tries to restore `package.json` from that backup. If that happens, run `npm install` again to sync `node_modules`.

## Output example

```
✔ upgraded: lodash → 4.17.21
✔ upgraded: axios → 1.6.0
✖ skipped: legacy-lib (npm test failed)
⚠ peer conflict: some-package — …
```

## Architecture (overview)

| Area | Role |
|------|------|
| `core/graph.ts` | Build graph from `package.json` + published **peerDependencies** only (+ `@types/*` pairing); connected components → batches. |
| `core/dynamicGroups.ts` | Custom `linkedGroups` + graph-driven `LinkedGroup[]`. |
| `core/conflictParser.ts` / `conflictAnalyzer.ts` | Parse and classify npm log lines; decide rollback after “successful” installs. |
| `core/resolver.ts` | Semver helpers and compatible-version search (extensible for smarter resolution). |
| `core/retryEngine.ts` | Generic retry helper. |
| `cli/interactive.ts` | `prompts`-based choices for failed groups. |
| `cli/report.ts` | Structured report builder and optional CLI summary. |
| `utils/registryCache.ts` / `utils/concurrency.ts` | Manifest cache and parallel fetch limits. |

## Testing

```bash
npm test
```

Runs **unit tests** (conflict parsing, no network) and **fixture integration tests** (`test/fixtures/*/package.json` with `dep-up-surgeon --dry-run --json`). Fixtures require **network** access to the npm registry. See `test/fixtures/README.md`.

## Development

This package is **ESM-only** (`"type": "module"`): source lives under `src/`, compiles to `dist/*.js` with **TypeScript `module: NodeNext`**, and relative imports use **`.js` extensions** in source so Node resolves them correctly.

Requires **Node `^20.17.0` or `>=22.9.0`** (aligned with `pacote`).

```bash
npm install
npm run build
```

The compiled entry is `dist/cli.js` (see `"bin"` in `package.json`).

## Future work (tracked in code)

- Parallel upgrades with graph ordering  
- Monorepos / workspaces  
- pnpm / Yarn  
- Git integration (commit per success)  
- Deeper automatic resolution using peer-range intersection across a batch  
