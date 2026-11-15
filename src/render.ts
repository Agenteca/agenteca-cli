import type {
  ChangeData,
  InfoData,
  ListData,
  OutdatedData,
  RegistryListData,
  ScanData,
  SearchData,
  Warning,
} from './types.js';
import { t } from './i18n.js';

/** Text rendering, for humans. The stable contract is the --json output, not this text. */

/** Columns a string takes in a terminal: CJK characters take two, combining marks none. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (/\p{M}/u.test(ch)) continue;
    width +=
      /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
        ? 2
        : 1;
  }
  return width;
}

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - displayWidth(c))))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const SIGN: Record<string, string> = {
  create: '+',
  update: '~',
  unchanged: '=',
  conflict: '!',
  remove: '-',
  delete: '-',
  missing: ' ',
};
const short = (sha?: string): string => (sha ? sha.slice(0, 7) : '');

export function warnings(list: Warning[]): string {
  return list.map((w) => t('Warning [{0}] {1}\n', [w.code, w.message])).join('');
}

function scanLines(scan: ScanData): string[] {
  const { critical, warning, info } = scan.summary;
  const lines = [
    t('Security scan: {0} critical, {1} warning(s), {2} informational', [critical, warning, info]),
  ];
  for (const f of scan.findings)
    lines.push(`  [${f.severity}] ${f.ruleId} ${f.path}:${f.line}:${f.column} — ${f.message}`);
  return lines;
}

export function scan(data: ScanData & { target: string; filesScanned: number }): string {
  const lines = [t('{0} file(s) scanned in {1}', [data.filesScanned, data.target]), ...scanLines(data)];
  if (data.blocked)
    lines.push(t('Result: critical findings — a package in this state is refused at installation.'));
  return lines.join('\n');
}

export function plan(data: ChangeData): string {
  const lines: string[] = [];
  const scope = data.scope === 'user' ? t('user') : t('project');
  lines.push(t('Scope: {0} — tools: {1}', [scope, data.targets.join(', ')]));

  if (data.packages.length > 0 || data.removedPackages.length > 0) {
    lines.push('', t('Packages'));
    const mark = { added: '+', updated: '~', unchanged: '=' };
    for (const p of data.packages) {
      const version = p.resolvedTag ?? p.version ?? short(p.commit) ?? '';
      const from =
        p.change === 'updated' && p.previousCommit ? t(' (from {0})', [short(p.previousCommit)]) : '';
      lines.push(
        `  ${mark[p.change]} ${p.name} ${version}${from}${p.direct ? '' : t(' (dependency)')}  ${p.identity}`,
      );
    }
    for (const id of data.removedPackages) lines.push(`  - ${id}`);
  }

  const files = data.files.filter((f) => f.action !== 'unchanged');
  if (files.length > 0) {
    lines.push('', t('Files to write ({0})', [files.length]));
    for (const f of files) {
      const note =
        f.action === 'conflict'
          ? f.reason === 'modified'
            ? t('  ← edited by hand')
            : t('  ← already exists, not managed by ahub')
          : f.action === 'update'
            ? t('  (update)')
            : '';
      lines.push(`  ${SIGN[f.action]} ${f.path}${note}`);
    }
  }
  const removals = data.removals.filter((r) => r.action !== 'missing');
  if (removals.length > 0) {
    lines.push('', t('Files to remove ({0})', [removals.length]));
    for (const r of removals)
      lines.push(
        `  ${r.action === 'conflict' ? '!' : '-'} ${r.path}${r.action === 'conflict' ? t('  ← edited by hand') : ''}`,
      );
  }
  const configs = data.configFiles.filter((c) => c.action !== 'unchanged' || c.conflicts.length > 0);
  if (configs.length > 0) {
    lines.push('', t('Configuration files modified (only these entries change)'));
    for (const c of configs)
      lines.push(`  ${SIGN[c.action]} ${c.path}: ${c.changes.join(', ') || t('no change')}`);
  }
  if (data.executables.length > 0) {
    lines.push('', t('Executable items — read them before accepting'));
    lines.push(
      table(
        data.executables.map((e) => [
          `  ${e.kind === 'hook' ? 'hook' : t('MCP server')}`,
          e.target,
          e.kind === 'hook' ? `${e.name} (${e.detail})` : `${e.name} (${e.detail})`,
          e.command,
        ]),
      ),
    );
  }
  lines.push('', ...scanLines(data.scan));
  return lines.join('\n');
}

export function applied(data: ChangeData): string {
  const r = data.result!;
  const parts = [t('{0} file(s) written', [r.written.length]), t('{0} removed', [r.removed.length])];
  if (r.skipped.length > 0) parts.push(t('{0} left untouched', [r.skipped.length]));
  return t('Done: {0}.', [parts.join(', ')]);
}

export function list(data: ListData): string {
  if (data.packages.length === 0) return t('No package installed.');
  return table([
    [t('PACKAGE'), t('VERSION'), t('TOOLS'), t('FILES'), t('SOURCE')],
    ...data.packages.map((p) => [
      p.direct ? p.name : t('{0} (dependency)', [p.name]),
      p.resolvedTag ?? p.version ?? short(p.commit) ?? '—',
      p.targets.join(',') || '—',
      String(p.files.length + p.mergedFiles.length),
      p.identity,
    ]),
  ]);
}

export function outdated(data: OutdatedData): string {
  const rows = data.packages.filter((p) => p.outdated || p.latest !== p.current);
  if (rows.length === 0) return t('All packages are up to date.');
  return [
    table([
      [t('PACKAGE'), t('INSTALLED'), t('WANTED'), t('LATEST')],
      ...rows.map((p) => [p.name, p.current, p.wanted, p.latest]),
    ]),
    '',
    t('"Wanted" respects the range of the manifest; "ahub update" installs it.'),
  ].join('\n');
}

export function search(data: SearchData): string {
  if (data.results.length === 0)
    return data.query ? t('No result for "{0}".', [data.query]) : t('No package in the registries.');
  const lines: string[] = [];
  for (const r of data.results) {
    lines.push(
      `${r.name}@${r.registry}${r.version ? `  ${r.version}` : ''}${r.tools?.length ? `  [${r.tools.join(', ')}]` : ''}`,
    );
    if (r.description) lines.push(`  ${r.description}`);
    lines.push(`  ahub add ${r.name}@${r.registry}`);
  }
  return lines.join('\n');
}

export function info(data: InfoData): string {
  const lines = [`${data.name}${data.version ? ` ${data.version}` : ''}  (${data.identity})`];
  if (data.description) lines.push(data.description);
  if (data.license) lines.push(t('License: {0}', [data.license]));
  if (data.resolvedTag || data.commit)
    lines.push(t('Resolved version: {0} {1}', [data.resolvedTag ?? '', short(data.commit)]).trimEnd());
  const c = data.contents;
  const section = (title: string, items: string[]): void => {
    if (items.length > 0) lines.push(t('{0}: {1}', [title, items.join(', ')]));
  };
  lines.push('');
  section(t('Skills'), c.skills);
  section(t('Agents'), c.agents);
  section(t('Commands'), c.commands);
  section(t('Instructions'), c.instructions);
  section(t('Hooks'), c.hooks);
  for (const m of data.mcpServers)
    lines.push(
      t('MCP server: {0} — {1}', [
        m.name,
        m.command ? [m.command, ...(m.args ?? [])].join(' ') : (m.url ?? ''),
      ]),
    );
  section(t('Dependencies'), data.dependencies);
  lines.push('', t('Files ({0})', [data.files.length]));
  for (const f of data.files) {
    lines.push(`  ${f.path}  (${t('{0} bytes', [f.size])})`);
    if (f.text !== undefined) lines.push(...f.text.split('\n').map((l) => `    | ${l}`));
  }
  lines.push('', ...scanLines(data.scan));
  return lines.join('\n');
}

export function registries(data: RegistryListData): string {
  if (data.registries.length === 0) return t('No registry configured. Add one: ahub registry add <url>');
  return table([[t('NAME'), t('TYPE'), 'URL'], ...data.registries.map((r) => [r.name, r.kind, r.url])]);
}
