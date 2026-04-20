import path from 'node:path';
import fs from 'fs-extra';
import type { ConflictEntry, LockfileFixReport, UpgradeRecord } from '../types.js';
import type { StructuredReport } from './report.js';

/**
 * Self-contained stylesheet embedded into every HTML summary. Kept deliberately short + GitHub
 * Actions / email friendly:
 *   - Scoped to `.dep-up-surgeon-report` so it can't leak into a host page / step-summary that
 *     also contains other tool output.
 *   - Uses system fonts only — no web fonts or external URLs.
 *   - Severity chips use the same palette as npm / GitHub advisory UIs so reviewers recognise
 *     the colors at a glance (critical=red, high=orange, moderate=amber, low=grey).
 *   - Tables fold down on narrow viewports by switching to `display:block` + horizontal scroll
 *     rather than reflowing cells, which preserves column-alignment readability.
 */
const SUMMARY_CSS = `
.dep-up-surgeon-report { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; color: #1f2328; }
.dep-up-surgeon-report h2 { margin-top: 0; font-size: 1.5em; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
.dep-up-surgeon-report h3 { margin-top: 1.5em; font-size: 1.15em; border-bottom: 1px solid #d1d9e0b3; padding-bottom: 0.2em; }
.dep-up-surgeon-report h4 { margin-top: 1.25em; font-size: 1em; color: #59636e; }
.dep-up-surgeon-report code { background: #afb8c133; padding: 0.15em 0.35em; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.dep-up-surgeon-report pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; }
.dep-up-surgeon-report pre code { background: transparent; padding: 0; }
.dep-up-surgeon-report table { border-collapse: collapse; margin: 0.5em 0 1em; width: 100%; max-width: 100%; overflow-x: auto; display: block; }
.dep-up-surgeon-report thead { background: #f6f8fa; }
.dep-up-surgeon-report th, .dep-up-surgeon-report td { border: 1px solid #d1d9e0; padding: 6px 10px; text-align: left; vertical-align: top; }
.dep-up-surgeon-report a { color: #0969da; text-decoration: none; }
.dep-up-surgeon-report a:hover { text-decoration: underline; }
.dep-up-surgeon-report details { margin: 0.4em 0; }
.dep-up-surgeon-report details > summary { cursor: pointer; padding: 4px 0; }
.dep-up-surgeon-report blockquote { border-left: 3px solid #d1d9e0; padding: 0.4em 0.8em; color: #59636e; background: #f6f8fa; margin: 0.5em 0; }
.dep-up-surgeon-report .chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1.5; vertical-align: middle; }
.dep-up-surgeon-report .chip-critical { background: #ffebe9; color: #a40e26; border: 1px solid #ffb4a8; }
.dep-up-surgeon-report .chip-high { background: #fff1e5; color: #9a3412; border: 1px solid #ffb787; }
.dep-up-surgeon-report .chip-moderate { background: #fff8c5; color: #7d4e00; border: 1px solid #e6d47a; }
.dep-up-surgeon-report .chip-low { background: #eaeef2; color: #59636e; border: 1px solid #d1d9e0; }
.dep-up-surgeon-report .chip-breaking { background: #ffebe9; color: #a40e26; border: 1px solid #ffb4a8; }
.dep-up-surgeon-report .chip-peer { background: #ddf4ff; color: #0550ae; border: 1px solid #54aeff; }
.dep-up-surgeon-report .chip-security { background: #fff8c5; color: #7d4e00; border: 1px solid #e6d47a; }
.dep-up-surgeon-report .chip-fallback { background: #eaeef2; color: #59636e; border: 1px solid #d1d9e0; }
.dep-up-surgeon-report .chip-forced { background: #ffd8b5; color: #9a3412; border: 1px solid #ffb787; }
.dep-up-surgeon-report .note-bits { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; }
`.trim();

const VALID_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);
function severityChip(severity: string, esc: (s: unknown) => string): string {
  const sev = VALID_SEVERITIES.has(severity) ? severity : 'low';
  return `<span class="chip chip-${sev}">${esc(severity)}</span>`;
}

export type SummaryFormat = 'md' | 'html';

export interface SummaryWriteOptions {
  format: SummaryFormat;
  /** Explicit destination path. Wins over `GITHUB_STEP_SUMMARY` and the default file. */
  file?: string;
  /** Workspace root, used to compute the default file location. */
  cwd: string;
  /** Tool version, included in the summary header for traceability. */
  toolVersion: string;
  /** Override env (mostly for tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_BASENAME = 'dep-up-surgeon-summary';

/**
 * Resolve the destination for a `--summary` write:
 *
 *   1. Explicit `--summary-file <path>` if set.
 *   2. `$GITHUB_STEP_SUMMARY` (GitHub Actions convention — appended).
 *   3. `<cwd>/dep-up-surgeon-summary.<ext>`.
 */
export function resolveSummaryDestination(opts: SummaryWriteOptions): { path: string; append: boolean } {
  const env = opts.env ?? process.env;
  if (opts.file) {
    return { path: path.resolve(opts.cwd, opts.file), append: false };
  }
  const stepSummary = env.GITHUB_STEP_SUMMARY;
  if (stepSummary && stepSummary.length > 0) {
    // GitHub Actions expects appended Markdown. We only support `md` for that path; if the
    // caller asked for `html` we still write valid HTML and the action runner will render it
    // raw, but Markdown is strongly preferred — log a warning at the call site if needed.
    return { path: stepSummary, append: true };
  }
  const ext = opts.format === 'html' ? 'html' : 'md';
  return { path: path.join(opts.cwd, `${DEFAULT_BASENAME}.${ext}`), append: false };
}

export async function writeSummary(
  structured: StructuredReport,
  opts: SummaryWriteOptions,
): Promise<string | undefined> {
  const dest = resolveSummaryDestination(opts);
  const body =
    opts.format === 'html'
      ? renderSummaryHtml(structured, opts.toolVersion)
      : renderSummaryMarkdown(structured, opts.toolVersion);
  try {
    if (dest.append) {
      await fs.appendFile(dest.path, body + '\n', 'utf8');
    } else {
      await fs.writeFile(dest.path, body + '\n', 'utf8');
    }
    return dest.path;
  } catch {
    return undefined;
  }
}

function workspaceTag(workspace: string | undefined): string {
  return workspace && workspace !== 'root' ? ` _(${workspace})_` : '';
}

/**
 * Light escape for Markdown special characters that would otherwise mangle a breaking-change
 * line lifted verbatim from a changelog (e.g. `|` in a table cell, backticks breaking code
 * spans). Conservative — we leave `*`/`_` alone because changelogs intentionally use them
 * for emphasis and stripping would read worse than preserving.
 */
function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

function workspaceTagPlain(workspace: string | undefined): string {
  return workspace && workspace !== 'root' ? ` (${workspace})` : '';
}

export function renderSummaryMarkdown(structured: StructuredReport, toolVersion: string): string {
  const lines: string[] = [];
  const upgraded = structured.upgraded.filter((r) => r.success && !r.skipped);
  const failed = structured.failed;

  lines.push(`## dep-up-surgeon — upgrade report`);
  lines.push('');
  lines.push(
    `_${upgraded.length} upgraded, ${failed.length} failed, ${structured.skipped.length} skipped — dep-up-surgeon \`${toolVersion}\`_`,
  );
  lines.push('');

  if (structured.project) {
    const p = structured.project;
    const mgr = `${p.manager}${p.managerVersion ? '@' + p.managerVersion : ''}`;
    const ws = p.hasWorkspaces ? `, ${p.workspaceMembers.length} workspace member(s)` : '';
    lines.push(`**Project**: ${mgr} (via \`${p.managerSource}\`${ws})`);
    if (structured.targets && structured.targets.length > 1) {
      lines.push(
        `**Targets**: ${structured.targets.map((t) => `\`${t.label}\``).join(', ')}`,
      );
    }
    lines.push('');
  }

  if (structured.preflightAborted) {
    lines.push(`> Pre-flight validator failed; the run aborted before any upgrade.`);
    if (structured.preflight) {
      lines.push(
        `> \`${structured.preflight.command ?? '?'}\` exited \`${structured.preflight.exitCode ?? '?'}\`.`,
      );
    }
    lines.push('');
  }

  // Security-only mode puts vulns above everything else for reviewer attention.
  const securityRows = upgraded.filter((r) => r.security);
  if (securityRows.length > 0) {
    lines.push(`### Security fixes`);
    lines.push('');
    lines.push(`| Package | Severity | Advisory | From → To | Title |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const r of securityRows) {
      const s = r.security!;
      const idCell = s.ids[0]
        ? s.url
          ? `[${s.ids[0]}](${s.url})`
          : `\`${s.ids[0]}\``
        : s.url
          ? `[link](${s.url})`
          : '';
      lines.push(
        `| \`${r.name}\`${workspaceTag(r.workspace)} | **${s.severity}** | ${idCell} | \`${r.from ?? '?'}\` → \`${r.to ?? '?'}\` | ${s.title ?? ''} |`,
      );
    }
    lines.push('');
  }

  // Breaking-changes roll-up sits above the Upgraded table so reviewers never miss it. Only
  // renders when at least one excerpt was scanned and matched; a package with no changelog
  // excerpt fetched is never flagged (we can't know either way).
  const breakingRows = upgraded.filter(
    (r) => r.changelog?.breaking?.hasBreaking === true,
  );
  if (breakingRows.length > 0) {
    lines.push(`### :warning: Breaking changes detected`);
    lines.push('');
    lines.push(
      `_${breakingRows.length} upgrade${breakingRows.length === 1 ? '' : 's'} include breaking-change markers. Review these carefully before merging._`,
    );
    lines.push('');
    for (const r of breakingRows) {
      const b = r.changelog!.breaking!;
      lines.push(`- **\`${r.name}\`** \`${r.from ?? '?'}\` → \`${r.to ?? '?'}\`${workspaceTag(r.workspace)}`);
      for (const line of b.matchedLines.slice(0, 5)) {
        lines.push(`  - ${escapeMd(line)}`);
      }
    }
    lines.push('');
  }

  // Peer-range intersection resolver breadcrumbs — list only the rows that were actually
  // nudged off the user's requested target so the reviewer can see which linked-group
  // members were compromised and why.
  const peerResolved = upgraded.filter((r) => r.resolvedPeer);
  if (peerResolved.length > 0) {
    lines.push(`### Peer-range resolutions`);
    lines.push('');
    lines.push(
      `_${peerResolved.length} package${peerResolved.length === 1 ? ' was' : 's were'} pinned below the requested latest because a linked-group peer constraint would otherwise have broken the install. Each row shows the originally requested version alongside the compatible version the resolver picked._`,
    );
    lines.push('');
    lines.push(`| Package | Group | Requested | Installed | Tuples explored |`);
    lines.push(`| --- | --- | --- | --- | ---: |`);
    for (const r of peerResolved) {
      const rp = r.resolvedPeer!;
      lines.push(
        `| \`${r.name}\` | \`${r.linkedGroupId ?? '?'}\` | \`${rp.originalTarget}\` | \`${r.to ?? '?'}\` | ${rp.tuplesExplored} |`,
      );
    }
    lines.push('');
  }

  if (upgraded.length) {
    lines.push(`### Upgraded`);
    lines.push('');
    lines.push(`| Package | Workspace | From | To | Notes |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const r of upgraded) {
      lines.push(
        `| \`${r.name}\` | ${r.workspace ?? 'root'} | \`${r.from ?? '?'}\` | \`${r.to ?? '?'}\` | ${formatUpgradeNote(r)} |`,
      );
    }
    lines.push('');

    // Render a collapsible <details> block per upgrade that has a changelog excerpt. Using
    // <details> keeps the summary compact by default while letting reviewers click to expand.
    // On GitHub's Markdown renderer this works in both issues / PR bodies and the Job Summary.
    const withChangelog = upgraded.filter((r) => r.changelog?.body);
    if (withChangelog.length > 0) {
      lines.push(`#### Release notes`);
      lines.push('');
      for (const r of withChangelog) {
        const cl = r.changelog!;
        const sourceLabel = cl.source === 'github-release' ? 'GitHub Release' : 'CHANGELOG.md';
        const linkSuffix = cl.url ? ` — [source](${cl.url})` : '';
        lines.push(
          `<details><summary><code>${r.name}</code> ${r.from ?? '?'} → ${r.to ?? '?'} <em>(${sourceLabel})</em></summary>`,
        );
        lines.push('');
        lines.push(cl.body.trim());
        lines.push('');
        if (linkSuffix) {
          lines.push(`_${linkSuffix.trim().replace(/^—\s*/, '')}_`);
        }
        lines.push('');
        lines.push(`</details>`);
        lines.push('');
      }
    }

    // Blast-radius: which project source files import the upgraded packages. Rendered as a
    // collapsible per-package block so the summary stays compact when the list is long.
    const withBlast = upgraded.filter((r) => r.blastRadius && r.blastRadius.total > 0);
    if (withBlast.length > 0) {
      lines.push(`#### Blast radius (source imports)`);
      lines.push('');
      for (const r of withBlast) {
        const b = r.blastRadius!;
        const header = `<code>${r.name}</code> — ${b.total} file${b.total === 1 ? '' : 's'}${b.truncated ? ' (showing first ' + b.files.length + ')' : ''}`;
        lines.push(`<details><summary>${header}</summary>`);
        lines.push('');
        for (const f of b.files) {
          lines.push(`- \`${f}\``);
        }
        lines.push('');
        lines.push(`</details>`);
        lines.push('');
      }
    }
  }

  if (failed.length) {
    lines.push(`### Failed or rolled back`);
    lines.push('');
    lines.push(`| Package | Workspace | Reason | Attempted | Detail |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const f of failed) {
      lines.push(
        `| \`${f.name}\`${workspaceTag(f.workspace)} | ${f.workspace ?? 'root'} | \`${f.reason}\` | \`${f.attemptedVersion ?? '?'}\` | ${formatFailureNote(f)} |`,
      );
    }
    lines.push('');
  }

  if (structured.ignored?.length) {
    lines.push(`### Ignored`);
    lines.push('');
    lines.push(structured.ignored.map((n) => `\`${n}\``).join(', '));
    lines.push('');
  }

  if (structured.lockfileFix) {
    const lf = structured.lockfileFix;
    lines.push(`### Lockfile fix`);
    lines.push('');
    lines.push(renderLockfileFixSummaryLine(lf));
    lines.push('');
    const interesting = lf.dedupeChanges.filter(
      (c) => c.change === 'merged' || c.change === 'updated',
    );
    if (interesting.length > 0) {
      lines.push(`| Package | Change | Before | After |`);
      lines.push(`| --- | --- | --- | --- |`);
      for (const c of interesting.slice(0, 50)) {
        lines.push(
          `| \`${c.name}\` | ${c.change} | ${c.before.map((v) => `\`${v}\``).join(', ') || '—'} | ${c.after.map((v) => `\`${v}\``).join(', ') || '—'} |`,
        );
      }
      if (interesting.length > 50) {
        lines.push('');
        lines.push(`_…and ${interesting.length - 50} more not shown._`);
      }
      lines.push('');
    }
    if (lf.stale.length > 0) {
      lines.push(`<details><summary>Stale transitives (${lf.stale.length} — \`package.json\` untouched)</summary>`);
      lines.push('');
      lines.push(`| Package | Installed | Latest | Major behind | Minor behind |`);
      lines.push(`| --- | --- | --- | ---: | ---: |`);
      for (const s of lf.stale.slice(0, 25)) {
        lines.push(
          `| \`${s.name}\` | ${s.installed.map((v) => `\`${v}\``).join(', ')} | \`${s.latest}\` | ${s.majorBehind} | ${s.minorBehind} |`,
        );
      }
      if (lf.stale.length > 25) {
        lines.push('');
        lines.push(`_…and ${lf.stale.length - 25} more not shown._`);
      }
      lines.push('');
      lines.push(`</details>`);
      lines.push('');
    }
    if (lf.status === 'failed' && lf.lastLines) {
      lines.push(`<details><summary>${lf.failureKind ?? 'dedupe'} output (last lines)</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(lf.lastLines);
      lines.push('```');
      lines.push('');
      lines.push(`</details>`);
      lines.push('');
    }
  }

  if (structured.overrides && structured.overrides.attempts.length > 0) {
    const ok = structured.overrides.attempts.filter((a) => a.ok && !a.skipped);
    const noOp = structured.overrides.attempts.filter((a) => a.ok && a.skipped);
    const failed = structured.overrides.attempts.filter((a) => !a.ok);
    lines.push(`### Overrides applied`);
    lines.push('');
    lines.push(
      `_wrote to \`${structured.overrides.field}\` — ${ok.length} pinned, ${noOp.length} already safe, ${failed.length} failed._`,
    );
    lines.push('');
    if (ok.length > 0) {
      // Show the `Reason` column only when at least one pin carries a policy reason — keeps
      // the table narrow for the common advisory-only case.
      const hasReason = ok.some((a) => typeof a.policyReason === 'string' && a.policyReason);
      const header = hasReason
        ? `| Package | Pinned to | Source | Severity | Advisory | Reason |`
        : `| Package | Pinned to | Source | Severity | Advisory |`;
      const sep = hasReason
        ? `| --- | --- | --- | --- | --- | --- |`
        : `| --- | --- | --- | --- | --- |`;
      lines.push(header);
      lines.push(sep);
      for (const a of ok) {
        const advCell = a.url && a.ids[0] ? `[${a.ids[0]}](${a.url})` : a.ids[0] ?? '';
        const label =
          a.chain && a.chain.length > 1 ? a.chain.join(' › ') : a.name;
        const sourceLabel = a.source === 'manual' ? '`--override`' : 'advisory';
        const base = `| \`${label}\` | \`${a.applied ?? '?'}\` | ${sourceLabel} | ${a.severity} | ${advCell} |`;
        lines.push(hasReason ? `${base} ${a.policyReason ?? ''} |` : base);
      }
      lines.push('');
    }
    if (failed.length > 0) {
      lines.push(`**Failed overrides** (rolled back):`);
      for (const a of failed) {
        const label = a.chain && a.chain.length > 1 ? a.chain.join(' › ') : a.name;
        lines.push(`- \`${label}\` — ${a.reason ?? 'unknown'}`);
      }
      lines.push('');
    }
  }

  if (structured.pullRequest) {
    const pr = structured.pullRequest;
    lines.push(`### Pull request`);
    lines.push('');
    if (pr.ok && pr.url) {
      lines.push(`- [${pr.url}](${pr.url}) on \`${pr.branch}\`${pr.reused ? ' (reused existing)' : ''}${pr.draft ? ' _(draft)_' : ''}`);
    } else if (pr.ok) {
      lines.push(`- opened on \`${pr.branch}\`${pr.reused ? ' (reused existing)' : ''}`);
    } else {
      lines.push(`- **failed** on \`${pr.branch ?? '?'}\`: ${pr.error ?? 'unknown error'}`);
    }
    lines.push('');
  }

  if (structured.policy && (structured.policy.frozen.length > 0 || structured.policy.applied.length > 0)) {
    lines.push(`### Policy`);
    lines.push('');
    if (structured.policy.sourceFile) {
      lines.push(`_loaded from \`${structured.policy.sourceFile}\`_`);
      lines.push('');
    }
    if (structured.policy.frozen.length > 0) {
      lines.push(`**Frozen** (${structured.policy.frozen.length}):`);
      for (const f of structured.policy.frozen) {
        const reason = f.reason ? ` — ${f.reason}` : '';
        lines.push(`- \`${f.name}\` (matches \`${f.pattern}\`)${reason}`);
      }
      lines.push('');
    }
    if (structured.policy.applied.length > 0) {
      lines.push(`**Applied rules** (${structured.policy.applied.length}):`);
      for (const a of structured.policy.applied) {
        lines.push(`- \`${a.name}\` — ${a.detail}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderSummaryHtml(structured: StructuredReport, toolVersion: string): string {
  const upgraded = structured.upgraded.filter((r) => r.success && !r.skipped);
  const failed = structured.failed;
  const esc = (s: unknown): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const out: string[] = [];
  // Inline stylesheet first, then the scoping wrapper. The `<style>` tag is stripped by
  // GitHub's sanitizer in issue / PR / step-summary contexts, in which case the HTML still
  // renders as plain tables (graceful degradation). When the summary is saved to a file and
  // opened in a browser — the primary `--summary html` use case — the stylesheet applies and
  // the report gets chips + proper table styling without any external assets.
  out.push(`<style>${SUMMARY_CSS}</style>`);
  out.push(`<section class="dep-up-surgeon-report">`);
  out.push(`<h2>dep-up-surgeon — upgrade report</h2>`);
  out.push(
    `<p><em>${upgraded.length} upgraded, ${failed.length} failed, ${structured.skipped.length} skipped — dep-up-surgeon <code>${esc(toolVersion)}</code></em></p>`,
  );

  if (structured.project) {
    const p = structured.project;
    const mgr = `${p.manager}${p.managerVersion ? '@' + p.managerVersion : ''}`;
    const ws = p.hasWorkspaces ? `, ${p.workspaceMembers.length} workspace member(s)` : '';
    out.push(`<p><strong>Project:</strong> ${esc(mgr)} (via <code>${esc(p.managerSource)}</code>${esc(ws)})</p>`);
    if (structured.targets && structured.targets.length > 1) {
      out.push(
        `<p><strong>Targets:</strong> ${structured.targets.map((t) => `<code>${esc(t.label)}</code>`).join(', ')}</p>`,
      );
    }
  }

  if (structured.preflightAborted) {
    out.push(`<blockquote>Pre-flight validator failed; the run aborted before any upgrade.</blockquote>`);
  }

  const securityRowsHtml = upgraded.filter((r) => r.security);
  if (securityRowsHtml.length > 0) {
    out.push(`<h3>Security fixes</h3>`);
    out.push(
      `<table><thead><tr><th>Package</th><th>Severity</th><th>Advisory</th><th>From → To</th><th>Title</th></tr></thead><tbody>`,
    );
    for (const r of securityRowsHtml) {
      const s = r.security!;
      const advCell = s.ids[0]
        ? s.url
          ? `<a href="${esc(s.url)}" rel="noreferrer noopener"><code>${esc(s.ids[0])}</code></a>`
          : `<code>${esc(s.ids[0])}</code>`
        : s.url
          ? `<a href="${esc(s.url)}" rel="noreferrer noopener">link</a>`
          : '';
      out.push(
        `<tr><td><code>${esc(r.name)}</code>${esc(workspaceTagPlain(r.workspace))}</td><td>${severityChip(s.severity, esc)}</td><td>${advCell}</td><td><code>${esc(r.from ?? '?')}</code> → <code>${esc(r.to ?? '?')}</code></td><td>${esc(s.title ?? '')}</td></tr>`,
      );
    }
    out.push(`</tbody></table>`);
  }

  const breakingRowsHtml = upgraded.filter(
    (r) => r.changelog?.breaking?.hasBreaking === true,
  );
  if (breakingRowsHtml.length > 0) {
    out.push(`<h3>⚠️ Breaking changes detected</h3>`);
    out.push(
      `<p><em>${breakingRowsHtml.length} upgrade${breakingRowsHtml.length === 1 ? '' : 's'} include breaking-change markers. Review carefully before merging.</em></p>`,
    );
    out.push(`<ul>`);
    for (const r of breakingRowsHtml) {
      const b = r.changelog!.breaking!;
      out.push(
        `<li><strong><code>${esc(r.name)}</code></strong> <code>${esc(r.from ?? '?')}</code> → <code>${esc(r.to ?? '?')}</code>${esc(workspaceTagPlain(r.workspace))}<ul>`,
      );
      for (const line of b.matchedLines.slice(0, 5)) {
        out.push(`<li>${esc(line)}</li>`);
      }
      out.push(`</ul></li>`);
    }
    out.push(`</ul>`);
  }

  const peerResolvedHtml = upgraded.filter((r) => r.resolvedPeer);
  if (peerResolvedHtml.length > 0) {
    out.push(`<h3>Peer-range resolutions</h3>`);
    out.push(
      `<p><em>${peerResolvedHtml.length} package${peerResolvedHtml.length === 1 ? ' was' : 's were'} pinned below the requested latest because a linked-group peer constraint would otherwise have broken the install.</em></p>`,
    );
    out.push(
      `<table><thead><tr><th>Package</th><th>Group</th><th>Requested</th><th>Installed</th><th>Tuples explored</th></tr></thead><tbody>`,
    );
    for (const r of peerResolvedHtml) {
      const rp = r.resolvedPeer!;
      out.push(
        `<tr><td><code>${esc(r.name)}</code></td><td><code>${esc(r.linkedGroupId ?? '?')}</code></td><td><code>${esc(rp.originalTarget)}</code></td><td><code>${esc(r.to ?? '?')}</code></td><td>${rp.tuplesExplored}</td></tr>`,
      );
    }
    out.push(`</tbody></table>`);
  }

  if (upgraded.length) {
    out.push(`<h3>Upgraded</h3>`);
    out.push(`<table><thead><tr><th>Package</th><th>Workspace</th><th>From</th><th>To</th><th>Notes</th></tr></thead><tbody>`);
    for (const r of upgraded) {
      out.push(
        `<tr><td><code>${esc(r.name)}</code></td><td>${esc(r.workspace ?? 'root')}</td><td><code>${esc(r.from ?? '?')}</code></td><td><code>${esc(r.to ?? '?')}</code></td><td>${formatUpgradeNoteHtml(r, esc)}</td></tr>`,
      );
    }
    out.push(`</tbody></table>`);

    const withChangelog = upgraded.filter((r) => r.changelog?.body);
    if (withChangelog.length > 0) {
      out.push(`<h4>Release notes</h4>`);
      for (const r of withChangelog) {
        const cl = r.changelog!;
        const sourceLabel = cl.source === 'github-release' ? 'GitHub Release' : 'CHANGELOG.md';
        const link = cl.url
          ? ` <a href="${esc(cl.url)}" rel="noreferrer noopener">source</a>`
          : '';
        out.push(
          `<details><summary><code>${esc(r.name)}</code> ${esc(r.from ?? '?')} → ${esc(r.to ?? '?')} <em>(${esc(sourceLabel)})</em>${link}</summary>`,
        );
        // Preserve line breaks from the excerpt; treat the body as pre-formatted text so markup
        // inside the changelog doesn't collide with the surrounding summary styling.
        out.push(`<pre>${esc(cl.body.trim())}</pre>`);
        out.push(`</details>`);
      }
    }

    const withBlastHtml = upgraded.filter((r) => r.blastRadius && r.blastRadius.total > 0);
    if (withBlastHtml.length > 0) {
      out.push(`<h4>Blast radius (source imports)</h4>`);
      for (const r of withBlastHtml) {
        const b = r.blastRadius!;
        const truncatedNote = b.truncated ? ` (showing first ${b.files.length})` : '';
        out.push(
          `<details><summary><code>${esc(r.name)}</code> — ${b.total} file${b.total === 1 ? '' : 's'}${esc(truncatedNote)}</summary><ul>`,
        );
        for (const f of b.files) {
          out.push(`<li><code>${esc(f)}</code></li>`);
        }
        out.push(`</ul></details>`);
      }
    }
  }

  if (failed.length) {
    out.push(`<h3>Failed or rolled back</h3>`);
    out.push(`<table><thead><tr><th>Package</th><th>Workspace</th><th>Reason</th><th>Attempted</th><th>Detail</th></tr></thead><tbody>`);
    for (const f of failed) {
      out.push(
        `<tr><td><code>${esc(f.name)}</code>${esc(workspaceTagPlain(f.workspace))}</td><td>${esc(f.workspace ?? 'root')}</td><td><code>${esc(f.reason)}</code></td><td><code>${esc(f.attemptedVersion ?? '?')}</code></td><td>${esc(formatFailureNote(f))}</td></tr>`,
      );
    }
    out.push(`</tbody></table>`);
  }

  if (structured.ignored?.length) {
    out.push(`<h3>Ignored</h3>`);
    out.push(`<p>${structured.ignored.map((n) => `<code>${esc(n)}</code>`).join(', ')}</p>`);
  }

  if (structured.lockfileFix) {
    const lf = structured.lockfileFix;
    out.push(`<h3>Lockfile fix</h3>`);
    out.push(`<p><em>${esc(renderLockfileFixSummaryLine(lf))}</em></p>`);
    const interesting = lf.dedupeChanges.filter(
      (c) => c.change === 'merged' || c.change === 'updated',
    );
    if (interesting.length > 0) {
      out.push(
        `<table><thead><tr><th>Package</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>`,
      );
      for (const c of interesting.slice(0, 50)) {
        const chipKind = c.change === 'merged' ? 'chip-peer' : 'chip-low';
        const beforeCell =
          c.before.length > 0 ? c.before.map((v) => `<code>${esc(v)}</code>`).join(', ') : '—';
        const afterCell =
          c.after.length > 0 ? c.after.map((v) => `<code>${esc(v)}</code>`).join(', ') : '—';
        out.push(
          `<tr><td><code>${esc(c.name)}</code></td><td><span class="chip ${chipKind}">${esc(c.change)}</span></td><td>${beforeCell}</td><td>${afterCell}</td></tr>`,
        );
      }
      out.push(`</tbody></table>`);
      if (interesting.length > 50) {
        out.push(`<p><em>…and ${interesting.length - 50} more not shown.</em></p>`);
      }
    }
    if (lf.stale.length > 0) {
      out.push(
        `<details><summary>Stale transitives (${lf.stale.length} — <code>package.json</code> untouched)</summary>`,
      );
      out.push(
        `<table><thead><tr><th>Package</th><th>Installed</th><th>Latest</th><th>Major behind</th><th>Minor behind</th></tr></thead><tbody>`,
      );
      for (const s of lf.stale.slice(0, 25)) {
        out.push(
          `<tr><td><code>${esc(s.name)}</code></td><td>${s.installed.map((v) => `<code>${esc(v)}</code>`).join(', ')}</td><td><code>${esc(s.latest)}</code></td><td>${s.majorBehind}</td><td>${s.minorBehind}</td></tr>`,
        );
      }
      out.push(`</tbody></table>`);
      if (lf.stale.length > 25) {
        out.push(`<p><em>…and ${lf.stale.length - 25} more not shown.</em></p>`);
      }
      out.push(`</details>`);
    }
    if (lf.status === 'failed' && lf.lastLines) {
      out.push(
        `<details><summary>${esc(lf.failureKind ?? 'dedupe')} output (last lines)</summary><pre>${esc(lf.lastLines)}</pre></details>`,
      );
    }
  }

  out.push(`</section>`);
  return out.join('\n');
}

/**
 * One-line human summary of a lockfile-fix report. Shared by the Markdown and HTML
 * renderers so the wording stays consistent.
 */
function renderLockfileFixSummaryLine(lf: LockfileFixReport): string {
  if (lf.status === 'skipped') {
    const reason =
      lf.skipReason === 'no-lockfile'
        ? 'no lockfile was present on disk'
        : 'package manager has no dedupe subcommand (yarn classic)';
    return `Skipped — ${reason}.`;
  }
  if (lf.status === 'dry-run') {
    return `Dry-run — would execute \`${lf.command}\`.`;
  }
  if (lf.status === 'failed') {
    const kind = lf.failureKind === 'validation' ? 'validator' : 'dedupe';
    return `Failed — ${kind} exited non-zero; lockfile was restored to its pre-dedupe state.`;
  }
  const merged = lf.dedupeChanges.filter((c) => c.change === 'merged').length;
  const updated = lf.dedupeChanges.filter((c) => c.change === 'updated').length;
  const stale = lf.stale.length;
  return `Ran \`${lf.command}\` — ${merged} merged, ${updated} updated, ${stale} stale transitive${stale === 1 ? '' : 's'} flagged.`;
}

function formatUpgradeNote(r: UpgradeRecord): string {
  const bits: string[] = [];
  if (r.changelog?.breaking?.hasBreaking) {
    bits.push(':warning: **breaking**');
  }
  if (r.security) {
    const id = r.security.ids[0];
    bits.push(id ? `security: **${r.security.severity}** (${id})` : `security: **${r.security.severity}**`);
  }
  if (r.linkedGroupId) {
    bits.push(`group \`${r.linkedGroupId}\``);
  }
  if (r.usedFallback && r.requestedLatest) {
    bits.push(`fallback (latest was \`${r.requestedLatest}\`)`);
  }
  if (r.resolvedPeer) {
    bits.push(`peer-resolved from \`${r.resolvedPeer.originalTarget}\``);
  }
  if (r.forced) {
    bits.push('forced');
  }
  return bits.join(', ');
}

/**
 * HTML variant of `formatUpgradeNote` — emits severity + classification chips + clickable
 * advisory IDs instead of a flat markdown string. Used only by `renderSummaryHtml`; the
 * Markdown renderer keeps `formatUpgradeNote` because chips don't render in plain MD.
 */
function formatUpgradeNoteHtml(r: UpgradeRecord, esc: (s: unknown) => string): string {
  const parts: string[] = [];
  if (r.changelog?.breaking?.hasBreaking) {
    parts.push(`<span class="chip chip-breaking">breaking</span>`);
  }
  if (r.security) {
    const id = r.security.ids[0];
    const idCell = id
      ? r.security.url
        ? ` <a href="${esc(r.security.url)}" rel="noreferrer noopener"><code>${esc(id)}</code></a>`
        : ` <code>${esc(id)}</code>`
      : '';
    parts.push(`${severityChip(r.security.severity, esc)}${idCell}`);
  }
  if (r.linkedGroupId) {
    parts.push(`<span class="chip chip-low">group <code>${esc(r.linkedGroupId)}</code></span>`);
  }
  if (r.usedFallback && r.requestedLatest) {
    parts.push(
      `<span class="chip chip-fallback">fallback</span> <em>(latest was <code>${esc(r.requestedLatest)}</code>)</em>`,
    );
  }
  if (r.resolvedPeer) {
    parts.push(
      `<span class="chip chip-peer">peer-resolved</span> <em>from <code>${esc(r.resolvedPeer.originalTarget)}</code></em>`,
    );
  }
  if (r.forced) {
    parts.push(`<span class="chip chip-forced">forced</span>`);
  }
  if (parts.length === 0) return '';
  return `<span class="note-bits">${parts.join(' ')}</span>`;
}

function formatFailureNote(f: ConflictEntry): string {
  if (f.reason === 'validation-script' && f.validation) {
    return `validator \`${f.validation.command ?? '?'}\` exited \`${f.validation.exitCode ?? '?'}\``;
  }
  if (f.install && !f.install.ok) {
    return `installer exited \`${f.install.exitCode ?? '?'}\``;
  }
  if (f.message) {
    // collapse to a single short line for the table cell
    return f.message.replace(/\s+/g, ' ').slice(0, 200);
  }
  return '';
}
