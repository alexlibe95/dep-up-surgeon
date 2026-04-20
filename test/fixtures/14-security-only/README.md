# fixture-security-only

Hand-built tree whose pins match the advisories in `audit-mixed-severities.json`:

| dependency  | pinned in package.json | advisory severity | patched version |
| ----------- | ---------------------- | ----------------- | --------------- |
| `axios`     | `^0.21.0`              | **high**          | `1.6.0`         |
| `lodash`    | `^4.17.20`             | **moderate**      | `4.17.21`       |
| `minimist`  | `^1.2.5`               | **low**           | `1.2.8`         |
| `left-pad`  | `^1.3.0`               | — (clean)         | —               |

Used by `test/unit/security-only.test.mjs` — the regression harness for
`--security-only`. We never shell out to real `npm audit` / `npm install` from these
tests; the audit blob is fed into `runAudit` via its `exec` injection and the install
step is replaced by a stub on `UpgradeEngineOptions.installer`.

`left-pad` is intentionally clean so assertions can check that packages **without**
advisories are excluded from the restricted plan.
