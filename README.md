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
| `--validate <cmd>` | Override the validator command run after every install. Defaults to `<manager> test` if a `test` script exists, else `<manager> run build` (yarn classic uses `yarn build`), else nothing. Useful in monorepos where the default build is heavy or fragile (e.g. `--validate "tsc -p tsconfig.json --noEmit"`). |
| `--no-validate` | Skip validation entirely. Upgrades are kept regardless of test/build outcome. Different from `--force`: `--force` runs the validator and only keeps the bump when it fails, `--no-validate` doesn’t run a validator at all. |
| `--package-manager <mgr>` | `auto` (**default**), `npm`, `pnpm`, or `yarn`. `auto` reads the `packageManager` field, then falls back to lockfile detection (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), then `pnpm-workspace.yaml`, then `npm`. The chosen manager drives both the **install** command (`<mgr> install`) and the **default validator** (`<mgr> test` / `<mgr> run build`). |
| `--include-workspace-deps` | By default, dependencies whose name matches a local **workspace package** (resolved via `workspaces` in `package.json` or `pnpm-workspace.yaml`) are skipped — their version comes from the local workspace, not the registry. Pass this flag to upgrade them anyway (e.g. when local workspace packages also publish to the registry). |
| `--workspaces` | Traverse the **root** `package.json` **and every workspace member** (one engine pass per `package.json`). Install + validation always run from the workspace root so the lockfile and validator see the whole monorepo. |
| `--workspaces-only` | Like `--workspaces` but **skips** the root `package.json`. Only workspace members are traversed. |
| `--workspace <names>` | Comma-separated workspace member **names** (the `name` field from each child `package.json`) to traverse. Pass `root` to also include the root. Example: `--workspace "@org/core,@org/web,root"`. Unknown names produce a friendly error listing the known members. |
| `--install-mode <mode>` | Workspace install strategy. **`root`** (default) always runs `<mgr> install` from the workspace root after every mutation — the safest option, supported by every package manager. **`filtered`** rewrites per-child installs to their workspace-scoped form: **npm 7+** uses `npm install --workspace <name>`, **pnpm** uses `pnpm install --filter <name>`, **yarn berry (v2+) with `@yarnpkg/plugin-workspace-tools`** uses `yarn workspaces focus <name>`, and **yarn classic / berry without the plugin** falls back to a full root install with a one-time warning explaining the upgrade path. The capability is auto-detected at startup (yarn version + plugin probe) and reported as `project.yarnMajorVersion` + `project.yarnSupportsFocus` in `--json`. Only meaningful with `--workspaces` / `--workspaces-only` / `--workspace <names>`. |
| `--concurrency <n>` | Maximum number of workspace targets to traverse in parallel (1–16; default `1`). Higher values overlap registry **scan + plan** phases across targets while a shared mutex keeps **install + validation strictly serialized** — the workspace lockfile is shared, so concurrent installs would corrupt it. The default in-process registry cache also deduplicates `pacote.manifest` / `pacote.packument` calls across targets, so even at concurrency `1` you get a speedup when the same dep appears in many workspaces. **Requires `--json`** so per-target log lines don't interleave; non-JSON mode silently downgrades to `1` with a warning. |
| `--retry-failed` | Read `.dep-up-surgeon.last-run.json` from the previous run and only re-attempt entries that failed for **non-terminal** reasons (`install`, `validation-conflicts`, `versions`, `unknown`). Successful upgrades + terminal failures (`peer`, `validation-script`) from the last run are added to the ignore list automatically. See **Persisted last-run report** below. |
| `--no-persist-report` | Do **not** write `.dep-up-surgeon.last-run.json` after the run. By default the structured report is written next to the workspace root for `--retry-failed` and CI consumers. |
| `--summary <format>` | Write a human-friendly summary of the run as `md` (default) or `html`. Destination is `$GITHUB_STEP_SUMMARY` if set (appended), otherwise `--summary-file <path>`, otherwise `./dep-up-surgeon-summary.<ext>`. |
| `--summary-file <path>` | Override the destination for `--summary`. Wins over `$GITHUB_STEP_SUMMARY`. |
| `--ci` | Convenience flag for CI / bot use. Disables `--interactive`, auto-enables `--summary md` (great with `$GITHUB_STEP_SUMMARY`), and **exits `0` even when individual upgrades fail** (only pre-flight failures and fatal errors exit `1`) so per-package conflicts surface in the PR description instead of failing the job. |
| `--git-commit` | Commit successful upgrades to git as the run progresses. Refuses to start on a dirty working tree (override with `--git-allow-dirty`). Only stages `package.json` + the lockfile — never `git add -A`, so unrelated WIP, generated files, and prepare/postinstall side effects are never accidentally swept into a commit. Skipped silently in `--dry-run`. |
| `--git-commit-mode <mode>` | How to group commits: **`per-success`** (default, one commit per upgrade — best for review and `git revert`-friendly), **`per-target`** (one commit per workspace target with all its successes squashed), or **`all`** (one commit at the end with everything). Linked-group upgrades (e.g. `react` + `react-dom`) always land in a single commit regardless of mode. |
| `--git-commit-prefix <prefix>` | String prepended to every commit message (default `"deps: "`). Use `"chore(deps): "` for [Conventional Commits](https://www.conventionalcommits.org/) or set it to your team's preferred convention. |
| `--git-branch <name>` | Create + checkout this branch before any commits. If the branch already exists, switches to it. Pairs nicely with `--ci` for PR-bot workflows (e.g. `--git-branch "deps/auto-$(date +%Y-%m-%d)"`). |
| `--git-sign` | Pass `--gpg-sign` to every commit. Requires a signing key configured in git (`user.signingkey` + `gpg.format`). Failed signatures are recorded as failed commits in the JSON report rather than aborting the run. |
| `--git-allow-dirty` | Allow `--git-commit` to run on a dirty working tree. We still only `git add` files we touched, so your WIP isn't swept up — but if you also `git add` your own files manually, they'll land in dep-up-surgeon's commits. |
| `--changelog` / `--no-changelog` | Fetch the bumped package's release notes (GitHub Releases first, then its published `CHANGELOG.md`) and include them in commit bodies + `--summary`. **Default ON** when `--git-commit` or `--summary` is active. Network failures are non-fatal — missing changelogs are silently skipped. See **Changelog excerpts** below. |
| `--security-only` | Run `npm audit` (or `pnpm`/`yarn` equivalent) first, then upgrade **only** the packages with open advisories. Every successful bump carries the advisory severity + ID into its commit subject (`[security:high]`) and into the summary's **Security fixes** table. Pairs well with `--git-commit-mode per-success` to produce one PR per CVE. See **Security-first mode** below. |
| `--min-severity <level>` | Minimum advisory severity to consider under `--security-only`: `low` (default), `moderate`, `high`, or `critical`. Lower-severity advisories are filtered out before the upgrade plan is built. |
| `--blast-radius` / `--no-blast-radius` | Scan project source files to list which files actually `import`/`require` each upgraded package, and surface the list in `--json` + `--summary`. **Default ON** when `--summary` is active. See **Blast radius** below. |

Exit code `1` when any upgrade could not be kept (unless `--force`). The CLI also exits `1` when the **pre-flight** validator (run on the unchanged tree) fails — see **Pre-flight check** below. Fatal errors also exit `1`.

### Pre-flight check

Before mutating any dependency, the CLI runs the resolved validator command **once** against the unchanged tree:

- If it **passes**, the run continues normally.
- If it **fails**, the run aborts immediately with an error containing the validator command, exit code, and last ~40 lines of output. This prevents the common failure mode where every per-group rollback looks identical because the project build was already broken before the run.
- To proceed anyway, use `--validate "<cmd>"` to swap the validator, `--no-validate` to skip it, or `--force` to ignore the pre-flight failure.

The pre-flight outcome is also surfaced under `preflight` / `preflightAborted` in `--json` output.

### Persisted last-run report

After every CLI run the structured report is written to `.dep-up-surgeon.last-run.json` next to the workspace root (set `--no-persist-report` to opt out). The file mirrors the `--json` output and adds a small header (`finishedAt`, `toolVersion`, `cwd`, `dryRun`) so CI dashboards / bots can pick it up without re-running the tool. Add it to your `.gitignore` if you don't want it tracked.

### Retry-failed mode (`--retry-failed`)

Pass `--retry-failed` to **resume** the previous run instead of starting from scratch:

- `dep-up-surgeon` reads `.dep-up-surgeon.last-run.json` and **freezes** every package that either:
  - **succeeded** in the last run (no need to redo work), **or**
  - failed for a **terminal** reason: `peer` (real peer-dep conflict; bumping the same package alone almost always fails the same way) or `validation-script` (the project's own test/build script crashed; re-running won't help without a code change).
- It then **re-attempts** only the residue: failures classified as `install`, `validation-conflicts`, `versions`, or `unknown`. These are the cases where another dependency move during the new run can plausibly unblock them.
- Linked-group failures (`name === '[group:<id>]'`) are expanded to **every member of the group** via the persisted `groups` field, so freezing a peer-failed group correctly freezes every package in it.
- If `.dep-up-surgeon.last-run.json` is missing the CLI exits `1` with a friendly message; pass `--retry-failed` only after at least one prior run.

Typical workflow:

```bash
dep-up-surgeon --workspaces           # first pass: lots of moves, some failures
# fix the script that caused a `validation-script` failure (or accept it)
dep-up-surgeon --retry-failed         # second pass: only retries install/conflict residue
```

### Summary writer (`--summary <md|html>`)

Pass `--summary md` (or `--summary html`) to render a human-friendly report alongside the normal output:

- **GitHub Actions**: when `GITHUB_STEP_SUMMARY` is set, the Markdown summary is **appended** to that file — it shows up in the job summary tab without any extra workflow plumbing.
- **Explicit destination**: `--summary-file <path>` overrides everything (wins over `$GITHUB_STEP_SUMMARY`).
- **Default**: `./dep-up-surgeon-summary.<md|html>`.

The summary contains: counts (upgraded / failed / skipped), detected project info, target list, an **Upgraded** table (`Package | Workspace | From | To | Notes`), a **Failed** table (`Package | Workspace | Reason | Attempted | Detail`), pre-flight status when it aborted, and the ignored list. HTML output escapes all dynamic content. Designed to be ~40 lines of code on the producer side and easy to embed in PR comments / dashboards.

### CI / bot mode (`--ci`)

`--ci` is a convenience flag for unattended runs (GitHub Actions, GitLab CI, Renovate-style bots). It:

- **Disables `--interactive`** unconditionally — never blocks on stdin.
- **Auto-enables `--summary md`** so a Markdown report lands in `$GITHUB_STEP_SUMMARY` (or `./dep-up-surgeon-summary.md` outside Actions). Pass an explicit `--summary html` if you'd rather have HTML.
- **Remaps the exit code**: per-package failures (peer conflicts, install crashes, validation script errors) are recorded in the report and the run still exits `0`, so the bot's PR carries the diagnostic instead of the job failing red. **Pre-flight failures and fatal errors still exit `1`** — those mean the project itself is broken before any upgrade and a human needs to look.

Typical GitHub Actions step:

```yaml
- name: dep-up-surgeon
  run: npx dep-up-surgeon --workspaces --ci
```

The job stays green; the **Summary** tab shows the upgraded / failed tables; `.dep-up-surgeon.last-run.json` is committed (or uploaded as an artifact) so a follow-up `--retry-failed` job can resume the residue.

### Git integration (`--git-commit`)

Pair `dep-up-surgeon` with git so every successful upgrade lands as its own atomic commit — perfect for code-review-friendly auto-update PRs.

```bash
# One commit per upgrade (best for review).
npx dep-up-surgeon --workspaces --git-commit

# One commit per workspace target (squashed) on a fresh branch.
npx dep-up-surgeon --workspaces \
  --git-commit --git-commit-mode per-target \
  --git-branch "deps/auto-$(date +%Y-%m-%d)"

# CI bot: per-success commits, Conventional Commits prefix, signed.
npx dep-up-surgeon --workspaces --ci \
  --git-commit \
  --git-commit-prefix "chore(deps): " \
  --git-sign
```

**Three commit modes:**

- **`per-success` (default)** — one commit per upgrade. Each commit contains exactly the `package.json` + lockfile diff for one dependency. Trivial to revert any single bump (`git revert <sha>`) and trivially reviewable in a PR. Linked-group upgrades (e.g. `react` + `react-dom`) still land as one commit since they were a single install.
- **`per-target`** — one commit per workspace target, listing every successful upgrade in the commit body. Useful for monorepos where you want each member's bumps grouped.
- **`all`** — one commit at the end with everything. Good for tiny single-package projects; avoid in monorepos.

**Safety:**

- Refuses to start on a **dirty working tree** unless you pass `--git-allow-dirty`. We don't want to accidentally commit your WIP.
- Only stages `package.json` + the lockfile — **never `git add -A`**. Files modified by `prepare`/`postinstall` hooks (e.g. `.husky/`) or other side effects of `npm install` stay uncommitted.
- Errors out cleanly when not in a git repo (instead of silently skipping).
- Skipped silently in `--dry-run` (no upgrades happen → nothing to commit).
- A failed `git commit` (signing rejected, pre-commit hook refused, etc.) is recorded as `commits[].ok === false` in the JSON report with the git stderr — the upgrade itself is **never rolled back** because of a commit failure.

**Concurrency-safe.** `--git-commit` works fine with `--workspaces --concurrency 8`: the same async mutex that serializes installs also serializes git invocations, so two targets can't race the index.

**Structured report.** Every commit attempt (success or failure) appears under `commits` in `--json` output:

```json
{
  "gitCommitMode": "per-success",
  "commits": [
    {
      "ok": true,
      "sha": "a1b2c3d",
      "message": "deps: bump axios from ^1.6.0 to ^1.7.2",
      "files": ["package.json", "package-lock.json"],
      "workspace": "root"
    }
  ]
}
```

### Changelog excerpts

Every successful upgrade can be annotated with the package's release notes so reviewers don't have to open five GitHub tabs per PR. Enabled by default when `--git-commit` or `--summary` is set; disable with `--no-changelog`.

- **Source.** First preference is the **GitHub Releases API** (`GET /repos/:owner/:repo/releases/tags/:tag`), resolved from the package's `repository` field in its `package.json`. Fallback is the `CHANGELOG.md` extracted from the published tarball via `pacote.extract` — the matching version section is parsed out with a Markdown-aware heading scanner (handles `## 1.2.3`, `## [1.2.3] - 2024-...`, `## v1.2.3`, etc.).
- **Where it shows up.** In `--git-commit-mode per-success`, the excerpt is embedded directly in the commit body. In `per-target` / `all` modes it collapses to a compact `See: <release-url>` footer so the commit doesn't balloon. `--summary md` / `--summary html` renders each excerpt in a collapsible `<details>` block — clean in PR bodies, compact in GitHub's Job Summary.
- **Caching & resilience.** A run-local cache deduplicates fetches across workspaces. Network errors, missing tags, private repos, and malformed `CHANGELOG.md` files are all silently skipped — a missing excerpt never fails a commit.
- **GitHub auth.** Anonymous GitHub API requests are rate-limited to 60/hour. Set `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment to lift that to 5,000/hour — `dep-up-surgeon` uses it automatically for changelog fetches and nothing else.

### Security-first mode

`--security-only` flips the tool from "bump everything safely" to "bump only packages with known CVEs". Competes directly with Dependabot's security-alert surface, but runs locally and respects your validator / policy / link groups.

1. Runs `npm audit --json` (or `pnpm audit --json` / `yarn audit` depending on the detected manager) **before** the upgrade plan is built.
2. Filters the audit to advisories at or above `--min-severity <low|moderate|high|critical>`.
3. Builds a `restrictToNames` set from the vulnerable package names and passes it to the engine — every other dependency gets added to the ignore list automatically (visible as `reason: "ignored"` in the report).
4. Attaches the severity + advisory ID + title to every upgraded record's `security` field, which the CLI then propagates into:
   - **Commit subjects**: `deps: [security:high] bump axios from 1.6.0 to 1.7.2`
   - **Commit bodies**: full advisory ID, URL, and title
   - **`--summary`**: a prominent **Security fixes** table above the normal upgraded table
   - **`--json`**: `upgraded[].security = { severity, ids, url, title, vulnerableRange, recommendedVersion }`

```bash
# Only critical + high; one commit per CVE on a dedicated branch.
npx dep-up-surgeon --workspaces --security-only --min-severity high \
  --git-commit --git-commit-mode per-success \
  --git-branch "deps/security-$(date +%Y-%m-%d)"
```

### Policy engine (policy-as-code)

Drop a `.dep-up-surgeon.policy.yaml` (or `.json`) in the repo root to encode upgrade rules that survive across runs and humans. Loaded automatically on startup; violations are reported per-package and the engine skips the offending bumps instead of failing.

```yaml
# .dep-up-surgeon.policy.yaml
freeze:
  - pattern: react               # never touch it
    reason: "React 18 pinned until Q3 refactor"
  - pattern: "@types/*"          # wildcard — freezes every @types/* scope
maxVersion:
  - pattern: next
    range: "<=14"                # refuse anything outside this semver range
allowMajorAfter:
  - pattern: eslint
    date: "2026-06-01"           # patch/minor OK now, majors blocked until the date
requireReviewers: 2              # metadata: surfaced in --summary / --json for your bot to consume
autoMerge: false                 # metadata: ditto
```

**How rules interact**

- **`freeze`** always wins. Exact names go straight into the ignore list; wildcards are matched against the scanned deps inside the engine so rules like `@types/*` don't have to be unrolled by hand. Freezes produce a `reason: "policy"` skip record with the originating pattern.
- **`maxVersion`** caps the candidate list. If no candidate satisfies the range, the package is skipped with `reason: "policy"` — it won't degrade to a no-op install.
- **`allowMajorAfter`** blocks **cross-major** bumps until the specified date (checked against `Date.now()`), demoting the candidate to the newest in-major version. Patch/minor still flow through normally.
- **`requireReviewers`** and **`autoMerge`** are **metadata only** — attached to the `policy` block of `--json` + `--summary` for downstream automation (GitHub Actions PR-opener, the SaaS bot, etc.) to consume.

Every applied rule appears in the **Policy** section of `--summary` and under `policy.applied` / `policy.frozen` / `policy.warnings` in `--json`, so audits show exactly which rule blocked which package.

### Blast radius

Before handing the PR to a reviewer, `dep-up-surgeon` can list **which of your own source files actually import each upgraded package**. Surfaced automatically under `--summary`; attach it to `--json` too with `--blast-radius`.

- **Scans**: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte`, `.astro`.
- **Skips**: `node_modules`, `dist`, `build`, `coverage`, `.git`, `.next`, `.turbo`, `.vercel`, `.cache`, `.parcel-cache`, `out`, `.output`.
- **Detects**: ES imports (`import x from '<pkg>'`), re-exports (`export … from '<pkg>'`), CommonJS `require('<pkg>')`, dynamic `import('<pkg>')`, and subpath imports (`from '<pkg>/sub'` still counts as a hit on `<pkg>`). Word-boundary safe — looking for `react` does not falsely match `react-dom`; looking for `@types/node` does not match `@types/node-ipc`.
- **Output**: per-package `{ total, truncated, files[] }` entries in `upgraded[].blastRadius`, plus a collapsible per-package list in the Markdown / HTML summary. Caps at 20 file paths per package by default; `total` keeps counting past the cap so the summary can honestly say "used in 134 files".
- **Cost**: a single pass over the tree, at most 1 MB read per file, parallel I/O (default concurrency 8). Failures are non-fatal — a broken symlink never aborts the run. Turn it off in huge monorepos with `--no-blast-radius`.

### Workspaces & package managers

`dep-up-surgeon` is **workspace-aware**:

- **Detection.** On startup the tool resolves the **package manager** (`npm` / `pnpm` / `yarn`) by reading, in order: the `--package-manager` flag, the `packageManager` field in `package.json`, the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), the presence of `pnpm-workspace.yaml`, and finally falls back to `npm`. **Workspace globs** are read from `workspaces` (npm/yarn — both array and `{ packages: [...] }` forms are supported) **or** `pnpm-workspace.yaml` (`packages:` list).
- **Install + validator follow the manager.** `<mgr> install` runs after each bump and the default validator becomes `<mgr> test` → `<mgr> run build` (yarn classic uses `yarn build`). Override with `--validate "<cmd>"` if you need something different (e.g. `pnpm -r build`).
- **Workspace-internal deps are skipped automatically.** If a dependency name matches a local workspace package, the tool does not try to resolve it from the npm registry — it appears in the report as `skipped` with `detail: "workspace-internal dep …"`. Pass `--include-workspace-deps` to override (useful when those packages are **also** published).
- **Workspace child traversal (`--workspaces` / `--workspaces-only` / `--workspace <names>`).** By default only the **root** `package.json` is mutated. With `--workspaces`, the tool **also** scans every member's `package.json` (one engine pass per file), but **install + validation always run from the workspace root** so the lockfile resolves correctly and the validator sees the entire monorepo. Pre-flight runs **once** at the workspace root regardless of how many targets are traversed. Every `upgraded` / `failed` row in the report is tagged with a `workspace` field (`"root"` or the member's package `name`) so you can tell at a glance which `package.json` produced each change.
- **Install mode (`--install-mode root|filtered`).** Default is `root`: every per-child mutation triggers a full `<mgr> install` from the workspace root — slow on large monorepos but supported by every package manager and impossible to misconfigure. Pass `--install-mode filtered` to rewrite per-child installs to their workspace-scoped form so only the affected member is resolved/linked:
  - **npm 7+** → `npm install --workspace <name>`
  - **pnpm** → `pnpm install --filter <name>`
  - **yarn berry (v2+) with [`@yarnpkg/plugin-workspace-tools`](https://yarnpkg.com/cli/workspaces/focus)** → `yarn workspaces focus <name>` (install the plugin once with `yarn plugin import workspace-tools`)
  - **yarn classic (v1.x)** → falls back to a full root install with a one-time warning suggesting an upgrade to yarn berry
  - **yarn berry without the plugin** → falls back to a full root install with a one-time warning telling you the exact `yarn plugin import` command to fix it

  The yarn capability is auto-probed at startup (`yarn --version` + `yarn workspaces focus --help`) and surfaced as `project.yarnMajorVersion` and `project.yarnSupportsFocus` in `--json`. The mode actually used is recorded as `installMode` in the report, and the exact filtered command appears under `failed[].install.command` when an upgrade rolls back.
- **Parallel target traversal (`--concurrency <n>`).** With more than one target, pass `--concurrency 4` (or up to `16`) to run target **scans + plans** concurrently. Registry IO (`pacote.manifest` / `pacote.packument`) is the slow part of each engine pass and is fully parallel-safe — overlapping it across targets gives a real wall-clock speedup on monorepos with many workspaces. **Installs and validations stay serialized** under a shared async mutex because they all touch the same root lockfile and `node_modules`; running them in parallel would corrupt the lockfile. An in-process registry cache (always on) also deduplicates fetches so the same dependency name in many workspaces only hits the network once. The effective concurrency is reported as `concurrency` in `--json` output. Parallelism requires `--json`; non-JSON mode silently downgrades to `1` to keep per-target log lines legible.

The detected manager + members are surfaced under `project` in `--json` output:

```json
"project": {
  "manager": "pnpm",
  "managerVersion": "9.10.0",
  "managerSource": "package.json:packageManager",
  "lockfile": "pnpm-lock.yaml",
  "hasWorkspaces": true,
  "workspaceGlobs": ["packages/*", "apps/*"],
  "workspaceMembers": [
    { "name": "@org/core", "dir": "/path/to/repo/packages/core" }
  ]
}
```

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
      "packages": ["package-a", "package-b"]
    }
  ],
  "validate": "tsc -p tsconfig.json --noEmit"
}
```

Ignored packages are never upgraded. The CLI `--ignore` list is merged with this file.

**`linkedGroups`** defines **forced** batches **before** the dynamic graph runs (exact npm package names).

**`validate`** overrides the validator command. Accepts either a shell string (`"tsc --noEmit"`) or an object: `{ "command": "pnpm -r build" }` or `{ "skip": true }`. CLI flags (`--validate`, `--no-validate`) always win over this file.

## JSON report (`--json`)

Stdout is a single JSON object including:

- **`upgraded`**, **`skipped`**, **`failed`**, **`conflicts`** (parsed from npm output), **`unresolved`** (failed entries), **`groups`** (planned linked groups: ids and package names), and **`ignored`**.
- **`preflight`** (when not skipped): `{ ok, command, exitCode, lastLines, source }` for the unchanged-tree validator run.
- **`preflightAborted: true`** if the run aborted before any upgrade.
- For each **failed** entry caused by the validator, a `validation` block with `{ command, exitCode, lastLines, source }` so you can tell at a glance whether the failure was a project-side script crash or an actual dependency conflict.
- For **every** failed entry, an `install` block with `{ command, exitCode, lastLines, ok }` capturing the install step that triggered the failure. `ok: true` means the installer process exited 0 but a post-install conflict scan triggered the rollback (peer warnings, "Conflicting peer dependency", etc.); `ok: false` means the installer itself crashed. `lastLines` is the **last ~40 lines** of combined stdout/stderr — usually enough to include the actual `npm ERR!` / pnpm / yarn footer.
- **`targets`**: list of `{ label, cwd, packageJson }` entries describing which `package.json` files were processed. With `--workspaces` / `--workspace <names>` this contains multiple entries (`label` = `"root"` or the workspace member's package `name`); without those flags it is a single root entry. Each `upgraded` / `failed` row also carries a matching `workspace` field. When more than one target is traversed, `groups[].id` values are namespaced as `"<workspace>::<group-id>"` so they stay unique across the aggregated report.
- The `failed[].reason` field uses `validation-script` for build/test script crashes and `validation-conflicts` for npm-reported peer issues; `peer` and `install` retain their meanings.
- **`project`**: `{ manager, managerVersion?, managerSource, lockfile?, hasWorkspaces, workspaceGlobs[], workspaceMembers[], yarnMajorVersion?, yarnSupportsFocus? }` — see **Workspaces & package managers** above. The two `yarn*` fields are only present when the active manager is yarn AND the project has workspaces (they drive the `--install-mode filtered` decision).
- **`installMode`**: `"root"` or `"filtered"` — the workspace install strategy actually used for this run.
- **`concurrency`**: effective number of targets traversed in parallel (only included when `> 1`).
- **`commits`** + **`gitCommitMode`**: only present when `--git-commit` was set. See **Git integration (`--git-commit`)** above for the full schema (each `commits[]` entry includes `ok`, `sha?`, `message`, `files`, `workspace?`, `groupId?`, and `error?` for failed signing / hook rejections).

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
| `cli.ts` | CLI entry point: parses flags via `commander`, loads `.dep-up-surgeonrc`, wires the orchestrator + Git flow + summary writer + persisted last-run + retry-failed mode. |
| `core/upgrader.ts` | Main upgrade engine + multi-target orchestrator (`runUpgradeEngine` / `runUpgradeFlow`). Owns the per-package and per-batch attempt loops, rollback, install/validation lock, parallel target traversal. |
| `core/workspaces.ts` | Detect package manager (`npm` / `pnpm` / `yarn`) + workspace topology, expand workspace globs, probe yarn capabilities (`yarnMajorVersion` + `yarnSupportsFocus` for `yarn workspaces focus`). |
| `core/scanner.ts` | Walk a `package.json` and emit the candidate dependency list (deps + devDeps + peerDeps + optionalDeps, registry-only). |
| `core/graph.ts` | Build the upgrade graph from `package.json` + published **peerDependencies** only (+ `@types/*` pairing); connected components → batches. |
| `core/dynamicGroups.ts` / `core/groups.ts` | Custom `linkedGroups` from `.dep-up-surgeonrc` merged with graph-driven `LinkedGroup[]`. |
| `core/conflictParser.ts` / `conflictAnalyzer.ts` | Parse and classify npm/pnpm/yarn log lines; decide whether a “successful” install should be rolled back. |
| `core/resolver.ts` / `utils/versionFallback.ts` | Semver helpers + per-major / per-minor fallback walking when `@latest` doesn't stick. |
| `core/validator.ts` | Pre-flight + per-attempt validator runner. Surfaces `ValidationDiagnostic` (`command`, `exitCode`, `lastLines`, `source`) on every failure. |
| `core/retryEngine.ts` | Generic retry helper. |
| `cli/interactive.ts` | `prompts`-based choices for failed packages and failed linked groups. |
| `cli/report.ts` | Structured `--json` report builder + on-screen summary printer. |
| `cli/summary.ts` | `--summary md\|html` writer; appends to `$GITHUB_STEP_SUMMARY` when present. |
| `cli/lastRun.ts` | Persist `.dep-up-surgeon.last-run.json` after every run + read it back for `--retry-failed` (terminal-vs-retryable failure classification). |
| `cli/git.ts` | Low-level git wrappers (`isGitRepo`, `gitAdd`, `gitCommit`, branch helpers) + commit message formatters for the three commit modes. |
| `cli/gitFlow.ts` | `--git-commit` controller: pre-flight checks (clean tree, branch checkout), buffers per-target / per-run changes, dispatches commits via the engine's `onUpgradeApplied` / `onTargetComplete` hooks under the install lock. |
| `utils/npm.ts` | `installCommand` (npm/pnpm/yarn variants incl. `yarn workspaces focus`), `runInstall`, registry helpers (`fetchLatestVersion`, `fetchAllPublishedVersions`), peer-conflict + ESM-vs-CJS heuristics. |
| `utils/registryCache.ts` / `utils/concurrency.ts` | In-process manifest/packument cache + bounded parallel fetch / per-target worker pool + async mutex used to serialize installs and git operations. |
| `config/loadConfig.ts` | Read + validate `.dep-up-surgeonrc` (`ignore`, `linkedGroups`, `validate`). |

## Testing

```bash
npm test
```

Runs **unit tests** (conflict parsing, npm output samples, workspace + yarn-capability detection, install command builder, concurrency primitives, summary writer, persisted last-run + retry classification, git helpers + flow controller — all offline) **and fixture integration tests** (`test/fixtures/*/package.json` exercised with `dep-up-surgeon --dry-run --json`). The fixture suite requires **network** access to the npm registry. See `test/fixtures/README.md`. Run only the offline suite with `npm run test:unit`.

## Development

This package is **ESM-only** (`"type": "module"`): source lives under `src/`, compiles to `dist/*.js` with **TypeScript `module: NodeNext`**, and relative imports use **`.js` extensions** in source so Node resolves them correctly.

Requires **Node `^20.17.0` or `>=22.9.0`** (aligned with `pacote`).

```bash
npm install
npm run build
```

The compiled entry is `dist/cli.js` (see `"bin"` in `package.json`).

## Future work (tracked in code)

- Auto-open a PR after `--git-commit --git-branch` (today the user / CI step runs `gh pr create` themselves)
- Deeper automatic resolution using peer-range intersection across a batch
- Renovate-style scheduling helpers (cron / day-of-week filters, grouping rules)
- True parallel installs in monorepos that don't share a root lockfile (e.g. nohoist setups), going beyond today's parallel scan + serial install model
- AI-assisted failure explanation: feed `install.lastLines` + `validation.lastLines` to an LLM and attach a one-sentence "why this broke" note to failed records
- Integration catalog: webhooks into Slack / Discord / Linear / Jira so the bot can ping a channel when a security bump lands, not just a GitHub PR

