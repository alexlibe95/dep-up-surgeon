import path from 'node:path';
import fs from 'fs-extra';
import type { ConflictEntry, UpgradeRecord } from '../types.js';
import type { StructuredReport } from './report.js';

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
        `<tr><td><code>${esc(r.name)}</code>${esc(workspaceTagPlain(r.workspace))}</td><td><strong>${esc(s.severity)}</strong></td><td>${advCell}</td><td><code>${esc(r.from ?? '?')}</code> → <code>${esc(r.to ?? '?')}</code></td><td>${esc(s.title ?? '')}</td></tr>`,
      );
    }
    out.push(`</tbody></table>`);
  }

  if (upgraded.length) {
    out.push(`<h3>Upgraded</h3>`);
    out.push(`<table><thead><tr><th>Package</th><th>Workspace</th><th>From</th><th>To</th><th>Notes</th></tr></thead><tbody>`);
    for (const r of upgraded) {
      out.push(
        `<tr><td><code>${esc(r.name)}</code></td><td>${esc(r.workspace ?? 'root')}</td><td><code>${esc(r.from ?? '?')}</code></td><td><code>${esc(r.to ?? '?')}</code></td><td>${esc(formatUpgradeNote(r))}</td></tr>`,
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

  out.push(`</section>`);
  return out.join('\n');
}

function formatUpgradeNote(r: UpgradeRecord): string {
  const bits: string[] = [];
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
  if (r.forced) {
    bits.push('forced');
  }
  return bits.join(', ');
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
