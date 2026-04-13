# dep-up-surgeon

Production-oriented CLI that upgrades **npm** `dependencies` and `devDependencies` with **`npm install` + validation** after each change, and **rolls back** on failure. With **`--link-groups auto`** (default) it **clusters** dependencies using the **registry graph** (see below) plus optional **`.dep-up-surgeonrc`** groups; use **`--link-groups none`** for strict one-package-at-a-time behavior.

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
| `--interactive` | On failure, prompt to continue, pin a package, or retry once; after the run, optionally bulk-add failed names to `.dep-up-surgeonrc`. |
| `--force` | Keep a version bump even when validation fails; also skips **peer-conflict rollback** when npm output suggests peer issues (use with care). |
| `--ignore <pkgs>` | Comma-separated package names to skip (merged with `.dep-up-surgeonrc`). |
| `--json` | Machine-readable report on stdout (suppresses colored logs). |
| `--fallback-strategy <mode>` | `major-lines` (**default**), `minor-lines`, or `none`. After `@latest` fails, **`major-lines`** tries the best stable version per **major** (e.g. `9.x` → `8.x` → `7.x` …) — fewer installs when a whole major changes behavior (e.g. **execa** 6+ is ESM-only). **`minor-lines`** steps one **`major.minor` line** at a time (more granular). If npm output looks like **ESM vs CommonJS** (`ERR_REQUIRE_ESM`), further fallbacks for that package **stop** so you don’t burn through every line. `none` only attempts `@latest`. |
| `--link-groups <mode>` | `auto` (**default**) or `none`. **`auto`** builds **linked batches** from the **npm registry** (see below) and optional **`linkedGroups`** in `.dep-up-surgeonrc`. **`none`** upgrades one dependency per step. |

Exit code `1` when any upgrade could not be kept (unless `--force`). Fatal errors also exit `1`.

### How linked groups are chosen (`--link-groups auto`)

There are **no hardcoded Expo/React lists**. Groups are derived **dynamically** from your **direct** `dependencies` / `devDependencies`:

1. **Custom** groups from `.dep-up-surgeonrc` `linkedGroups` are applied **first** (exact package names).
2. For every remaining **registry** dependency (semver / tag resolvable from npm), the tool fetches the published **`package.json`** via **`pacote`** and reads **`peerDependencies`** and **`dependencies`**.
3. An **undirected edge** is added between two project dependencies **A** and **B** when **B** appears in **A**’s published peer or runtime deps (and both are in your project). That way **peer** and **direct** links in the npm graph become upgrade batches.
4. **`@types/<pkg>`** is linked to **`<pkg>`** when **both** are direct dependencies (e.g. **`react`** ↔ **`@types/react`**), since TypeScript types often must move with the runtime.
5. **Connected components** of that graph are **one batch each** (one `package.json` edit + one `npm install` + one validation). Packages that are **not** connected to anything else are upgraded **alone**.

**Caveats** (inherent to any graph heuristic):

- **SDK-style** ecosystems (e.g. Expo) only cluster if the **published** manifests expose **`peerDependencies` / `dependencies`** edges between those packages. If two packages are **not** linked in the registry metadata, they will **not** be batched together — add **`linkedGroups`** in `.dep-up-surgeonrc` for that case.
- For **guaranteed** Expo SDK alignment, prefer **`npx expo install`**; this tool still helps **automate** semver bumps when the graph is visible to npm.
- **Prerelease / canary** lines: **`@latest`** may not match your channel — pin or ignore as needed.

**Performance**: one registry fetch per **registry** dependency when linking is enabled (batched in parallel).

### Why not only “latest”?

Packages may publish a `latest` that your project cannot adopt yet (for example **execa** 6+ is **ESM-only** while a `"type": "commonjs"` app still `require()`s it, or a **TypeScript** major breaks your build). The default strategy **tries `latest` first**, then walks older **release lines** so you often land on a **newer compatible** version. Use **`--fallback-strategy minor-lines`** if you want finer steps than one per major.

## Configuration

Create `.dep-up-surgeonrc` in the project root:

```json
{
  "ignore": ["some-legacy-package"],
  "linkedGroups": [
    {
      "id": "rn-addons",
      "packages": [
        "react-native-reanimated",
        "react-native-screens",
        "react-native-safe-area-context"
      ]
    }
  ]
}
```

Ignored packages are never upgraded. The CLI `--ignore` list is merged with this file.

**`linkedGroups`** defines **forced** batches **before** the dynamic graph runs (e.g. packages you know must move together but are not linked in registry metadata). Use exact npm package names.

## Safety

- Before the first real change, the tool copies `package.json` to `package.json.dep-up-surgeon.bak`.
- On uncaught errors, it tries to restore `package.json` from that backup. If that happens, run `npm install` again to sync `node_modules`.
- Non-registry ranges (`workspace:`, `link:`, `file:`, `git:` …) are skipped automatically.

## Peer dependencies

If `npm install` succeeds but combined output matches common **peer dependency** warning patterns, the tool treats that as a **peer conflict**, rolls back (unless `--force`), and suggests leaving the dependency unchanged or fixing peers manually.

## Output example

```
✔ upgraded: lodash → 4.17.21
✔ upgraded: axios → 1.6.0
✖ skipped: legacy-lib (npm test failed)
⚠ peer conflict: angular-plugin — …
```

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
