# dep-up-surgeon

Production-oriented CLI that upgrades **npm** `dependencies` and `devDependencies` with **`npm install` + validation** after each change, and **rolls back** on failure. By default it **links** related packages (Expo, React Native core, and optional groups in `.dep-up-surgeonrc`) so they bump **together** in one edit + one install; use `--link-groups none` for strict one-package-at-a-time behavior.

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
| `--link-groups <mode>` | `auto` (**default**) or `none`. **`auto`** upgrades **linked** sets in one step: built-in **`expo` + `expo-*` + `@expo/*`**, and **`react` + `react-dom` + `react-native` + `react-native-web`** when present, plus any **`linkedGroups`** from `.dep-up-surgeonrc`. **`none`** processes every dependency as its own step (legacy). |

Exit code `1` when any upgrade could not be kept (unless `--force`). Fatal errors also exit `1`.

### Linked upgrade groups (Expo / React / custom)

Many mobile stacks break if you bump **`expo`** without the matching **`expo-*`** packages, or **`react-native`** without compatible **`react`**. With `--link-groups auto` (default), the tool:

1. Applies **custom** groups from `.dep-up-surgeonrc` `linkedGroups` first (exact package names).
2. Puts **`expo`**, every **`expo-*`**, and **`@expo/*`** into one batch.
3. Puts **`react`**, **`react-dom`**, **`react-native`**, **`react-native-web`** into one batch.
4. Leaves other packages (e.g. **`react-native-reanimated`**, **`firebase`**, **`@tanstack/react-query`**) as **individual** upgrades unless you list them in **`linkedGroups`**.

A **linked** batch resolves **`@latest`** per package, writes **all** version bumps at once, runs **one** `npm install`, then **one** test/build validation. It does **not** replace `npx expo install`’s SDK pinning — for Expo, prefer **`expo install`** when you need guaranteed SDK alignment; this feature reduces “upgrade one expo package and break peers” during automated bumps.

**Prerelease / canary** tags (e.g. `expo@…-canary-…`) are still read as semver ranges; **`@latest`** may point at a different channel than your canary line — pin or ignore if needed.

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

**`linkedGroups`** defines extra batches (in addition to built-in Expo / React-core). Use exact npm package names.

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
