# Test fixtures

Each subdirectory is a **minimal project** (`package.json` only; some are distilled from real open-source repos — see **`SOURCES.md`**). Tests run:

```bash
dep-up-surgeon --dry-run --json
```

in each directory and check the JSON report.

**Requirements:** `npm run build` first; integration tests **call the npm registry** (via `pacote`) and need network access.

## Synthetic (`01`–`07`)

| Directory | Purpose |
|-----------|---------|
| `01-minimal-single` | One dependency (`lodash`). |
| `02-react-dom-types` | `react` / `react-dom` / `@types/react` — peer + types pairing. |
| `03-custom-linked-groups` | `.dep-up-surgeonrc` with `linkedGroups` id `custom-bundle`. |
| `04-workspace-non-registry` | Mix of registry (`left-pad`) and `workspace:*` (skipped for upgrade). |
| `05-root-name-app` | Root `name` matches a known false-positive pattern (`crypto-market-dashboard`). |
| `06-ignore-rc` | `ignore` in rc for `lodash`. |
| `07-two-unrelated` | Two packages with no peer edge — expect multiple groups (peer-only graph). |

## Repo-inspired (`08`–`12`)

| Directory | Notes |
|-----------|--------|
| `08-next-hello-world` | Next + React + TS (from Next.js `hello-world` example). |
| `09-vite-vue-ts` | Vite + Vue + TS (from Vite `template-vue-ts`). |
| `10-astro-minimal` | Single `astro` dep (from Astro `examples/minimal`). |
| `11-nest-sample-cats` | Nest + RxJS (from Nest `sample/01-cats-app`, trimmed). |
| `12-express-style` | Subset of Express’s runtime `dependencies` (many small packages). |

## Manual run

```bash
npm run build
cd test/fixtures/08-next-hello-world
node ../../../dist/cli.js --dry-run
```
