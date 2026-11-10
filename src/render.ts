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

/** Rendu texte, pour les humains. Le contrat stable est la sortie --json, pas ce texte. */

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
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
  return list.map((w) => `Avertissement [${w.code}] ${w.message}\n`).join('');
}

function scanLines(scan: ScanData): string[] {
  const { critical, warning, info } = scan.summary;
  const lines = [
    `Scan de sécurité : ${critical} critique(s), ${warning} avertissement(s), ${info} information(s)`,
  ];
  for (const f of scan.findings)
    lines.push(`  [${f.severity}] ${f.ruleId} ${f.path}:${f.line}:${f.column} — ${f.message}`);
  return lines;
}

export function scan(data: ScanData & { target: string; filesScanned: number }): string {
  const lines = [`${data.filesScanned} fichier(s) analysé(s) dans ${data.target}`, ...scanLines(data)];
  if (data.blocked)
    lines.push('Résultat : constats critiques — un paquet dans cet état est refusé à l’installation.');
  return lines.join('\n');
}

export function plan(data: ChangeData): string {
  const lines: string[] = [];
  const portee = data.scope === 'user' ? 'utilisateur' : 'projet';
  lines.push(`Portée : ${portee} — outils : ${data.targets.join(', ')}`);

  if (data.packages.length > 0 || data.removedPackages.length > 0) {
    lines.push('', 'Paquets');
    const mark = { added: '+', updated: '~', unchanged: '=' };
    for (const p of data.packages) {
      const version = p.resolvedTag ?? p.version ?? short(p.commit) ?? '';
      const from = p.change === 'updated' && p.previousCommit ? ` (depuis ${short(p.previousCommit)})` : '';
      lines.push(
        `  ${mark[p.change]} ${p.name} ${version}${from}${p.direct ? '' : ' (dépendance)'}  ${p.identity}`,
      );
    }
    for (const id of data.removedPackages) lines.push(`  - ${id}`);
  }

  const files = data.files.filter((f) => f.action !== 'unchanged');
  if (files.length > 0) {
    lines.push('', `Fichiers à écrire (${files.length})`);
    for (const f of files) {
      const note =
        f.action === 'conflict'
          ? f.reason === 'modified'
            ? '  ← modifié à la main'
            : '  ← existe déjà, non géré par ahub'
          : f.action === 'update'
            ? '  (mise à jour)'
            : '';
      lines.push(`  ${SIGN[f.action]} ${f.path}${note}`);
    }
  }
  const removals = data.removals.filter((r) => r.action !== 'missing');
  if (removals.length > 0) {
    lines.push('', `Fichiers à retirer (${removals.length})`);
    for (const r of removals)
      lines.push(
        `  ${r.action === 'conflict' ? '!' : '-'} ${r.path}${r.action === 'conflict' ? '  ← modifié à la main' : ''}`,
      );
  }
  const configs = data.configFiles.filter((c) => c.action !== 'unchanged' || c.conflicts.length > 0);
  if (configs.length > 0) {
    lines.push('', 'Fichiers de configuration modifiés (seules ces entrées changent)');
    for (const c of configs)
      lines.push(`  ${SIGN[c.action]} ${c.path} : ${c.changes.join(', ') || 'aucun changement'}`);
  }
  if (data.executables.length > 0) {
    lines.push('', 'Éléments exécutables — à lire avant d’accepter');
    lines.push(
      table(
        data.executables.map((e) => [
          `  ${e.kind === 'hook' ? 'hook' : 'serveur MCP'}`,
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
  const parts = [`${r.written.length} fichier(s) écrit(s)`, `${r.removed.length} retiré(s)`];
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} laissé(s) intact(s)`);
  return `Terminé : ${parts.join(', ')}.`;
}

export function list(data: ListData): string {
  if (data.packages.length === 0) return 'Aucun paquet installé.';
  return table([
    ['PAQUET', 'VERSION', 'OUTILS', 'FICHIERS', 'SOURCE'],
    ...data.packages.map((p) => [
      p.direct ? p.name : `${p.name} (dépendance)`,
      p.resolvedTag ?? p.version ?? short(p.commit) ?? '—',
      p.targets.join(',') || '—',
      String(p.files.length + p.mergedFiles.length),
      p.identity,
    ]),
  ]);
}

export function outdated(data: OutdatedData): string {
  const rows = data.packages.filter((p) => p.outdated || p.latest !== p.current);
  if (rows.length === 0) return 'Tous les paquets sont à jour.';
  return [
    table([
      ['PAQUET', 'INSTALLÉ', 'VOULU', 'DERNIER'],
      ...rows.map((p) => [p.name, p.current, p.wanted, p.latest]),
    ]),
    '',
    '« Voulu » respecte la plage du manifeste ; « ahub update » l’installe.',
  ].join('\n');
}

export function search(data: SearchData): string {
  if (data.results.length === 0)
    return data.query ? `Aucun résultat pour « ${data.query} ».` : 'Aucun paquet dans les registres.';
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
  if (data.license) lines.push(`Licence : ${data.license}`);
  if (data.resolvedTag || data.commit)
    lines.push(`Version résolue : ${data.resolvedTag ?? ''} ${short(data.commit)}`.trimEnd());
  const c = data.contents;
  const section = (title: string, items: string[]): void => {
    if (items.length > 0) lines.push(`${title} : ${items.join(', ')}`);
  };
  lines.push('');
  section('Skills', c.skills);
  section('Agents', c.agents);
  section('Commandes', c.commands);
  section('Instructions', c.instructions);
  section('Hooks', c.hooks);
  for (const m of data.mcpServers)
    lines.push(
      `Serveur MCP : ${m.name} — ${m.command ? [m.command, ...(m.args ?? [])].join(' ') : (m.url ?? '')}`,
    );
  section('Dépendances', data.dependencies);
  lines.push('', `Fichiers (${data.files.length})`);
  for (const f of data.files) {
    lines.push(`  ${f.path}  (${f.size} octets)`);
    if (f.text !== undefined) lines.push(...f.text.split('\n').map((l) => `    | ${l}`));
  }
  lines.push('', ...scanLines(data.scan));
  return lines.join('\n');
}

export function registries(data: RegistryListData): string {
  if (data.registries.length === 0)
    return 'Aucun registre configuré. Ajoutez-en un : ahub registry add <url>';
  return table([['NOM', 'TYPE', 'URL'], ...data.registries.map((r) => [r.name, r.kind, r.url])]);
}
