# dep-up-surgeon

[![npm version](https://img.shields.io/npm/v/dep-up-surgeon.svg)](https://www.npmjs.com/package/dep-up-surgeon)
[![npm downloads](https://img.shields.io/npm/dm/dep-up-surgeon.svg)](https://www.npmjs.com/package/dep-up-surgeon)
[![npm license](https://img.shields.io/npm/l/dep-up-surgeon.svg)](https://www.npmjs.com/package/dep-up-surgeon)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/dep-up-surgeon.svg)](https://www.npmjs.com/package/dep-up-surgeon)
[![Node.js engines](https://img.shields.io/node/v/dep-up-surgeon.svg)](https://github.com/alexlibe95/dep-up-surgeon/blob/main/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?logo=typescript&logoColor=white)](https://github.com/alexlibe95/dep-up-surgeon)
[![GitHub stars](https://img.shields.io/github/stars/alexlibe95/dep-up-surgeon?style=social)](https://github.com/alexlibe95/dep-up-surgeon)
[![GitHub forks](https://img.shields.io/github/forks/alexlibe95/dep-up-surgeon?style=social)](https://github.com/alexlibe95/dep-up-surgeon)
[![GitHub issues](https://img.shields.io/github/issues/alexlibe95/dep-up-surgeon.svg)](https://github.com/alexlibe95/dep-up-surgeon/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/alexlibe95/dep-up-surgeon.svg)](https://github.com/alexlibe95/dep-up-surgeon/pulls)
[![GitHub contributors](https://img.shields.io/github/contributors/alexlibe95/dep-up-surgeon.svg)](https://github.com/alexlibe95/dep-up-surgeon/graphs/contributors)
[![Last commit](https://img.shields.io/github/last-commit/alexlibe95/dep-up-surgeon/main.svg)](https://github.com/alexlibe95/dep-up-surgeon/commits/main)
[![Commit activity](https://img.shields.io/github/commit-activity/m/alexlibe95/dep-up-surgeon.svg)](https://github.com/alexlibe95/dep-up-surgeon/graphs/commit-activity)
[![Libraries.io release](https://img.shields.io/librariesio/release/npm/dep-up-surgeon.svg)](https://libraries.io/npm/dep-up-surgeon)
[![Libraries.io dependents](https://img.shields.io/librariesio/dependents/npm/dep-up-surgeon.svg)](https://libraries.io/npm/dep-up-surgeon)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fdep-up-surgeon.netlify.app%2F&label=website)](https://dep-up-surgeon.netlify.app/)

**Website:** [https://dep-up-surgeon.netlify.app/](https://dep-up-surgeon.netlify.app/)

**Quick links:** [Website](https://dep-up-surgeon.netlify.app/) · [npm package](https://www.npmjs.com/package/dep-up-surgeon) · [GitHub repository](https://github.com/alexlibe95/dep-up-surgeon) · [Issues](https://github.com/alexlibe95/dep-up-surgeon/issues) · [Pull requests](https://github.com/alexlibe95/dep-up-surgeon/pulls) · [Socket (supply chain & maintenance)](https://socket.dev/npm/package/dep-up-surgeon) · [deps.dev (Open Source Insights)](https://deps.dev/npm/dep-up-surgeon) · [Libraries.io](https://libraries.io/npm/dep-up-surgeon) · [npms score](https://npms.io/search?q=dep-up-surgeon) · [Bundlephobia](https://bundlephobia.com/package/dep-up-surgeon) · [OpenSSF Scorecard (repo)](https://scorecard.dev/viewer/?uri=github.com/alexlibe95/dep-up-surgeon)

Production-oriented CLI that upgrades **npm** dependencies with **`npm install` + validation** after each change, and **rolls back** on failure. It is **framework-agnostic**: grouping and conflict handling come from **registry metadata** and **parsed npm output**, not hardcoded stacks (React, Angular, etc.).

### Package listings and security tools

| Where | What you get |
|--------|----------------|
| **[Website](https://dep-up-surgeon.netlify.app/)** | Project landing page: overview, live demo/session log, feature highlights, install commands, and flag reference. |
| **[npm](https://www.npmjs.com/package/dep-up-surgeon)** | Current version, **readme**, **dependencies**, dist tags, publish time, tarball **integrity** (`sha512`), download counts, maintainers, and npm’s own **Security** / advisory context for the ecosystem. |
| **[GitHub](https://github.com/alexlibe95/dep-up-surgeon)** | **Stars**, **forks**, **issues**, **pull requests**, **commits**, **contributors**, source tree, and (if enabled) **Dependabot** / **Security** advisories for the repo. |
| **[Socket](https://socket.dev/npm/package/dep-up-surgeon)** | Supply-chain style view: **maintenance**, **license**, **dependencies**, and related signals npm users often open in dedicated security UIs. |
| **[deps.dev](https://deps.dev/npm/dep-up-surgeon)** | Google **Open Source Insights**: dependency graph, versions, licenses, and cross-ecosystem metadata. |
| **[Libraries.io](https://libraries.io/npm/dep-up-surgeon)** | Release history, **reverse dependencies** (who depends on this package), and ecosystem metadata. |
| **[npms](https://npms.io/search?q=dep-up-surgeon)** | Search **quality score** (maintenance, popularity, dependencies) used by many npm search front-ends. |
| **[OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/alexlibe95/dep-up-surgeon)** | Automated **security health** checks for the GitHub repository (when the project is indexed). |

**Note:** Badges above pull live data from **npm**, **GitHub**, and **Libraries.io**; numbers change as the package and repo evolve. For **your** app’s risk after installing any tool, always run **`npm audit`** (and your own policy) in the project directory.

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

**Runtime behavior (this CLI)**

- Before the first real change, the tool copies `package.json` to `package.json.dep-up-surgeon.bak`.
- On uncaught errors, it tries to restore `package.json` from that backup. If that happens, run `npm install` again to sync `node_modules`.

**Supply chain & registry trust**

- Use the **[Package listings and security tools](#package-listings-and-security-tools)** table above for links to **Socket**, **deps.dev**, **npm**, and **GitHub** signals (stars, issues, dependents).
- After installing or upgrading dependencies—including this tool—run **`npm audit`** in your project and follow your organization’s policy for **allowlists** and **lockfile** review.

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
