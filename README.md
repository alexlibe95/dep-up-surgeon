# dep-up-surgeon

Production-oriented CLI that upgrades **npm** `dependencies` and `devDependencies` **one package at a time**, runs `npm install` after each change, validates with `npm test` (or `npm run build` if there is no test script), and **rolls back** a change when install or validation fails.

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

Exit code `1` when any upgrade could not be kept (unless `--force`). Fatal errors also exit `1`.

## Configuration

Create `.dep-up-surgeonrc` in the project root:

```json
{
  "ignore": ["some-legacy-package"]
}
```

Ignored packages are never upgraded. The CLI `--ignore` list is merged with this file.

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
