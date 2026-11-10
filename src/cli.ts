import {
  AHUB_VERSION,
  AhubError,
  applyInstall,
  canonicalDepString,
  createContext,
  type DepRef,
  detectTargets,
  discardInstall,
  exportMarketplace,
  hasBlocking,
  inferRegistryKind,
  inspectPackage,
  type InstallRequest,
  listInstalled,
  listOutdated,
  loadCatalog,
  loadConfig,
  loadLock,
  loadManifest,
  ManifestFile,
  type MarketplaceFormat,
  parseCliPackageArg,
  parseDepString,
  prepareInstall,
  type PreparedInstall,
  type ProjectContext,
  type RegistryConfig,
  registryNameFromUrl,
  saveConfig,
  scanFiles,
  searchRegistries,
  summarizeFindings,
  SUPPORTED_TARGETS,
  type Target,
  toSarif,
} from '@agenteca/core';
import { Command, CommanderError, Option } from 'commander';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as render from './render.js';
import {
  type ChangeData,
  type Envelope,
  type ErrorCode,
  type ErrorInfo,
  EXIT,
  type InfoData,
  type InitData,
  type ListData,
  type OutdatedData,
  type RegistryData,
  type RegistryExportData,
  type RegistryListData,
  type ScanCommandData,
  SCHEMA_VERSION,
  type SearchData,
  type VersionData,
  type Warning,
} from './types.js';

/** Entrées-sorties injectables : la CLI se teste sans lancer de processus. */
export interface IO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  /** Pose une question et retourne la réponse ; absent hors terminal. */
  ask?(question: string): Promise<string>;
}

interface Outcome<T> {
  data: T | null;
  warnings?: Warning[];
  human?: string;
  error?: ErrorInfo;
  /** Sortie brute à la place de l'enveloppe (rapport SARIF). */
  raw?: string;
  exit?: number;
}

const require = createRequire(import.meta.url);
const CLI_VERSION = (require('../package.json') as { version: string }).version;

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'USAGE':
    case 'NO_TARGET':
      return EXIT.USAGE;
    case 'SCAN_BLOCKED':
      return EXIT.SCAN_BLOCKED;
    case 'CONFIRMATION_REQUIRED':
    case 'PLAN_CHANGED':
      return EXIT.CONFIRMATION_REQUIRED;
    case 'FILE_MODIFIED':
      return EXIT.FILE_MODIFIED;
    default:
      return EXIT.ERROR;
  }
}

function parseTools(value: string | undefined): Target[] | undefined {
  if (!value) return undefined;
  const out: Target[] = [];
  for (const raw of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const t = raw === 'vscode' ? 'copilot' : raw;
    if (t === 'all') return [...SUPPORTED_TARGETS];
    if (!(SUPPORTED_TARGETS as readonly string[]).includes(t)) {
      throw new AhubError(
        'USAGE',
        `outil inconnu « ${raw} ». Valeurs : ${SUPPORTED_TARGETS.join(', ')}, all.`,
      );
    }
    if (!out.includes(t as Target)) out.push(t as Target);
  }
  return out;
}

interface CommonOpts {
  json?: boolean;
  cwd?: string;
  global?: boolean;
  tool?: string;
}

interface ChangeOpts extends CommonOpts {
  yes?: boolean;
  dryRun?: boolean;
  allowUnsafe?: boolean;
  expectPlan?: string;
  overwrite?: string[];
  force?: boolean;
  frozen?: boolean;
  legacySkillPaths?: boolean;
}

function toChangeData(p: PreparedInstall, dryRun: boolean): ChangeData {
  return {
    applied: false,
    dryRun,
    planHash: p.planHash,
    scope: p.ctx.scope,
    targets: p.targets,
    packages: p.packages.map((pkg) => {
      const { summary, depth: _depth, ...rest } = pkg;
      return {
        ...rest,
        contents: {
          skills: summary.skills.map((s) => s.name),
          agents: summary.agents,
          commands: summary.commands,
          instructions: summary.instructions,
          hooks: summary.hooks.map((h) => h.name),
          mcpServers: summary.mcpServers.map((m) => m.name),
        },
      };
    }),
    removedPackages: p.removedPackages,
    files: p.plan.files.map((f) => ({
      path: f.path,
      action: f.action,
      ...(f.reason ? { reason: f.reason } : {}),
      primitive: f.primitive,
      targets: f.targets,
    })),
    removals: p.plan.removals.map((r) => ({ path: r.path, action: r.action })),
    configFiles: p.plan.merges.map((m) => ({
      path: m.path,
      kind: m.kind,
      action: m.action,
      changes: m.changes,
      conflicts: m.conflicts,
    })),
    executables: p.executables,
    scan: { blocked: p.blocked, summary: summarizeFindings(p.findings), findings: p.findings },
    conflicts: p.plan.conflicts,
  };
}

function hasChanges(p: PreparedInstall): boolean {
  return (
    p.manifestChanged ||
    p.removedPackages.length > 0 ||
    p.packages.some((x) => x.change !== 'unchanged') ||
    p.plan.files.some((f) => f.action !== 'unchanged') ||
    p.plan.removals.some((r) => r.action !== 'missing') ||
    p.plan.merges.some((m) => m.action !== 'unchanged')
  );
}

/** Parcourt un dossier pour le scan, sans suivre de lien symbolique. */
async function collectFiles(
  root: string,
  rel = '',
  out: Array<{ path: string; bytes: Buffer }> = [],
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const abs = rel ? path.join(root, rel) : root;
  for (const entry of (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const st = await lstat(path.join(root, childRel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) await collectFiles(root, childRel, out);
    else if (st.isFile() && st.size <= 5 * 1024 * 1024)
      out.push({ path: childRel, bytes: await readFile(path.join(root, childRel)) });
  }
  return out;
}

/** Point d'entrée de la CLI. Retourne le code de sortie. */
export async function run(argv: string[], io: IO): Promise<number> {
  let exitCode: number = EXIT.OK;
  const wantsJson = argv.includes('--json');
  let usageOutput = '';

  const emit = <T>(command: string, json: boolean, o: Outcome<T>): void => {
    const warnings = o.warnings ?? [];
    if (o.raw !== undefined) {
      io.out(o.raw.endsWith('\n') ? o.raw : `${o.raw}\n`);
    } else if (json) {
      const envelope: Envelope<T> = {
        schemaVersion: SCHEMA_VERSION,
        command,
        ok: !o.error,
        data: o.data,
        warnings,
        error: o.error ?? null,
      };
      io.out(JSON.stringify(envelope, null, 2) + '\n');
    } else {
      if (o.human) io.out(o.human.endsWith('\n') ? o.human : `${o.human}\n`);
      if (warnings.length > 0) io.err(render.warnings(warnings));
      if (o.error) io.err(`Erreur : ${o.error.message}\n`);
    }
    exitCode = o.exit ?? (o.error ? exitCodeFor(o.error.code) : EXIT.OK);
  };

  const exec = async <T>(command: string, opts: CommonOpts, fn: () => Promise<Outcome<T>>): Promise<void> => {
    try {
      emit(command, opts.json === true, await fn());
    } catch (e) {
      const error: ErrorInfo =
        e instanceof AhubError
          ? {
              code: e.code as ErrorCode,
              message: e.message,
              ...(e.details !== undefined ? { details: e.details } : {}),
            }
          : { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
      emit(command, opts.json === true, { data: null, error });
    }
  };

  const contextFor = (opts: CommonOpts): ProjectContext =>
    createContext({
      cwd: opts.cwd ? path.resolve(io.cwd, opts.cwd) : io.cwd,
      env: io.env,
      ...(opts.global ? { global: true } : {}),
    });

  const registryContext = (ctx: ProjectContext) => ({
    git: ctx.git,
    home: ctx.home,
    cwd: ctx.scope === 'user' ? io.cwd : ctx.root,
  });

  const interactive = (opts: CommonOpts): boolean => io.isTTY && !opts.json && typeof io.ask === 'function';
  const yes = async (question: string): Promise<boolean> =>
    /^(o|oui|y|yes)$/i.test((await io.ask!(`${question} [o/N] `)).trim());

  /** Traduit un argument de `add` en dépendance, en passant par les registres si besoin. */
  const resolvePackageArg = async (arg: string, ctx: ProjectContext): Promise<DepRef> => {
    const parsed = parseCliPackageArg(arg);
    if (parsed.type === 'dep') return parseDepString(parsed.dep);
    const config = await loadConfig(io.env);
    if (config.registries.length === 0) {
      throw new AhubError(
        'NOT_FOUND',
        `« ${arg} » ressemble à un nom de catalogue, mais aucun registre n’est configuré. Utilisez propriétaire/dépôt, ou « ahub registry add <url> ».`,
      );
    }
    const found = await searchRegistries(
      config.registries,
      '',
      registryContext(ctx),
      parsed.registry ? { registry: parsed.registry } : {},
    );
    const matches = found.entries.filter((e) => e.name === parsed.name);
    if (matches.length === 0) {
      const failed = found.failures.map((f) => `${f.registry} : ${f.message}`).join(' ; ');
      throw new AhubError(
        'NOT_FOUND',
        `aucun paquet « ${parsed.name} » dans ${parsed.registry ? `le registre « ${parsed.registry} »` : 'les registres configurés'}${failed ? ` (registres en échec — ${failed})` : ''}`,
      );
    }
    if (matches.length > 1) {
      throw new AhubError(
        'USAGE',
        `« ${parsed.name} » existe dans plusieurs registres : ${matches.map((m) => `${m.name}@${m.registry}`).join(', ')}. Précisez nom@registre.`,
      );
    }
    return parseDepString(matches[0]!.source);
  };

  /** Déroulé commun à add, install, update et remove : plan, garde-fous, confirmation, application. */
  const change = async (
    command: string,
    opts: ChangeOpts,
    build: (ctx: ProjectContext) => Promise<InstallRequest>,
  ): Promise<void> =>
    exec<ChangeData>(command, opts, async () => {
      const ctx = contextFor(opts);
      const req = await build(ctx);
      const tools = parseTools(opts.tool);
      if (tools) req.targets = tools;
      if (opts.legacySkillPaths) req.legacySkillPaths = true;
      const prepared = await prepareInstall(ctx, req);
      const data = toChangeData(prepared, opts.dryRun === true);
      const warnings: Warning[] = [
        ...prepared.diagnostics,
        ...prepared.plan.conflicts
          .filter((c) => c.reason === 'merge')
          .map((c) => ({ code: 'CONFIG_ENTRY_SKIPPED', message: c.message, path: c.path })),
      ];
      const stop = async (error: ErrorInfo, human = render.plan(data)): Promise<Outcome<ChangeData>> => {
        await discardInstall(prepared);
        return { data, warnings, human, error };
      };

      if (opts.dryRun) {
        await discardInstall(prepared);
        return { data, warnings, human: `${render.plan(data)}\nSimulation : rien n’a été écrit.` };
      }
      if (opts.expectPlan && opts.expectPlan !== prepared.planHash) {
        return stop({
          code: 'PLAN_CHANGED',
          message:
            'le contenu a changé depuis le plan approuvé : relancez avec --dry-run pour voir le nouveau plan',
        });
      }
      if (prepared.blocked && !opts.allowUnsafe) {
        return stop({
          code: 'SCAN_BLOCKED',
          message: `le scan de sécurité a relevé ${data.scan.summary.critical} constat(s) critique(s) : rien n’a été écrit. Contournement explicite : --allow-unsafe`,
        });
      }

      const overwrite = new Set<string>(opts.overwrite ?? []);
      const fileConflicts = prepared.plan.conflicts.filter((c) => c.reason !== 'merge');
      const uncovered = (): typeof fileConflicts =>
        opts.force ? [] : fileConflicts.filter((c) => !overwrite.has(c.path));
      const changed = hasChanges(prepared);

      if (!opts.json && changed) io.out(`${render.plan(data)}\n`);
      if (uncovered().length > 0) {
        if (interactive(opts)) {
          for (const c of uncovered()) {
            if (await yes(`${c.message}. L’écraser ou le supprimer ?`)) overwrite.add(c.path);
          }
        }
        if (uncovered().length > 0) {
          return stop(
            {
              code: 'FILE_MODIFIED',
              message: `${uncovered().length} fichier(s) modifié(s) à la main ou non géré(s) : rien n’a été écrit. Accord explicite : --overwrite <chemin> (ou --force pour tous)`,
              details: { conflicts: uncovered() },
            },
            '',
          );
        }
      }
      if (changed && !opts.yes) {
        if (!interactive(opts)) {
          return stop(
            {
              code: 'CONFIRMATION_REQUIRED',
              message: 'confirmation requise : relancez avec --yes (après un --dry-run pour lire le plan)',
            },
            '',
          );
        }
        if (!(await yes('Appliquer ces changements ?'))) {
          return stop({ code: 'CONFIRMATION_REQUIRED', message: 'annulé : rien n’a été écrit' }, '');
        }
      }

      const result = await applyInstall(prepared, {
        overwrite: opts.force ? 'all' : overwrite,
        ...(opts.allowUnsafe ? { allowUnsafe: true } : {}),
      });
      data.applied = true;
      data.result = { written: result.written, removed: result.removed, skipped: result.skipped };
      return { data, warnings, human: changed ? render.applied(data) : 'Tout est à jour : rien à faire.' };
    });

  const program = new Command('ahub')
    .description('Catalogue et gestionnaire d’agents IA pour Claude Code, Codex, GitHub Copilot et Cursor')
    .version(CLI_VERSION, '-V, --version', 'affiche la version')
    .helpOption('-h, --help', 'affiche l’aide')
    .helpCommand('help [commande]', 'affiche l’aide d’une commande')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => (usageOutput += s) });

  const common = (cmd: Command): Command =>
    cmd
      .option('--json', 'sortie JSON stable (contrat schemas/cli-output.v1.schema.json)')
      .option('--cwd <dossier>', 'dossier du projet (défaut : dossier courant)')
      .helpOption('-h, --help', 'affiche l’aide');
  const scoped = (cmd: Command): Command =>
    common(cmd).option('-g, --global', 'portée utilisateur (~/.apm) au lieu du projet');
  const changing = (cmd: Command): Command =>
    scoped(cmd)
      .addOption(
        new Option(
          '--tool <liste>',
          'outils cibles, séparés par des virgules : claude, codex, copilot, cursor, all',
        ),
      )
      .addOption(new Option('--target <liste>', 'alias de --tool').hideHelp())
      .option('-y, --yes', 'applique sans demander confirmation')
      .option('--dry-run', 'calcule et affiche le plan sans rien écrire')
      .option(
        '--expect-plan <empreinte>',
        'n’applique que si le plan a cette empreinte (planHash d’un --dry-run)',
      )
      .option('--allow-unsafe', 'déploie malgré des constats de sécurité critiques')
      .option(
        '--overwrite <chemin>',
        'accepte d’écraser ou de supprimer ce fichier modifié (répétable)',
        (v: string, acc: string[]) => [...acc, v],
        [] as string[],
      )
      .option('--force', 'accepte d’écraser ou de supprimer tous les fichiers modifiés')
      .option(
        '--legacy-skill-paths',
        'écrit les skills dans .github/skills et .cursor/skills plutôt que .agents/skills',
      );
  const withTool = <T extends ChangeOpts & { target?: string }>(o: T): T => {
    if (!o.tool && o.target) o.tool = o.target;
    return o;
  };

  common(program.command('version').description('affiche les versions de la CLI et du contrat JSON')).action(
    (opts: CommonOpts) =>
      exec<VersionData>('version', opts, async () => {
        const data: VersionData = {
          version: CLI_VERSION,
          schemaVersion: SCHEMA_VERSION,
          coreVersion: AHUB_VERSION,
          node: process.version,
        };
        return {
          data,
          human: `ahub ${data.version} (contrat JSON ${data.schemaVersion}, cœur ${data.coreVersion}, Node ${data.node})`,
        };
      }),
  );

  scoped(program.command('init').description('crée le manifeste apm.yml'))
    .option('--name <nom>', 'nom du projet (défaut : nom du dossier)')
    .option('--tool <liste>', 'outils cibles à déclarer dans le manifeste')
    .action((opts: CommonOpts & { name?: string }) =>
      exec<InitData>('init', opts, async () => {
        const ctx = contextFor(opts);
        const existing = await loadManifest(ctx);
        if (existing) {
          const data: InitData = {
            manifestPath: ctx.manifestPath,
            name: existing.manifest.name,
            targets: existing.manifest.targets ?? [],
            created: false,
          };
          return { data, human: `${ctx.manifestPath} existe déjà : inchangé.` };
        }
        const targets = parseTools(opts.tool) ?? detectTargets(ctx.root, ctx.scope);
        const name = opts.name ?? (ctx.scope === 'user' ? 'global' : path.basename(ctx.root));
        const mf = ManifestFile.create({ name, ...(targets.length > 0 ? { targets } : {}) });
        await mkdir(path.dirname(ctx.manifestPath), { recursive: true });
        await writeFile(ctx.manifestPath, mf.toString());
        const data: InitData = { manifestPath: ctx.manifestPath, name, targets, created: true };
        return {
          data,
          human: `Créé : ${ctx.manifestPath}\nOutils cibles : ${targets.length > 0 ? targets.join(', ') : 'aucun détecté — précisez --tool à l’installation'}`,
        };
      }),
    );

  changing(
    program
      .command('add')
      .description('ajoute un ou plusieurs paquets et les installe')
      .argument('<paquet...>', 'propriétaire/dépôt[@tag|#ref], URL git, chemin local, ou nom[@registre]'),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('add', withTool(opts), async (ctx) => {
      const add: DepRef[] = [];
      for (const p of pkgs) add.push(await resolvePackageArg(p, ctx));
      return { add, initName: ctx.scope === 'user' ? 'global' : path.basename(ctx.root) };
    }),
  );

  changing(
    program.command('install').description('installe ce que décrit le manifeste, en rejouant le lockfile'),
  )
    .option('--frozen', 'échoue si le lockfile ne couvre pas exactement le manifeste (usage en CI)')
    .action((opts: ChangeOpts) =>
      change('install', withTool(opts), async () => (opts.frozen ? { frozen: true } : {})),
    );

  changing(
    program
      .command('update')
      .description('met à jour tous les paquets, ou ceux indiqués')
      .argument('[paquet...]', 'paquets à mettre à jour'),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('update', withTool(opts), async () => ({ update: pkgs.length > 0 ? pkgs : 'all' })),
  );

  changing(
    program
      .command('remove')
      .alias('rm')
      .description('retire des paquets et tous leurs fichiers')
      .argument('<paquet...>', 'paquets à retirer'),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('remove', withTool(opts), async () => ({ remove: pkgs })),
  );

  scoped(program.command('list').alias('ls').description('liste les paquets installés')).action(
    (opts: CommonOpts) =>
      exec<ListData>('list', opts, async () => {
        const ctx = contextFor(opts);
        const data: ListData = { scope: ctx.scope, packages: listInstalled(await loadLock(ctx)) };
        return { data, human: render.list(data) };
      }),
  );

  scoped(program.command('outdated').description('liste les mises à jour disponibles')).action(
    (opts: CommonOpts) =>
      exec<OutdatedData>('outdated', opts, async () => {
        const data: OutdatedData = { packages: await listOutdated(contextFor(opts)) };
        return { data, human: render.outdated(data) };
      }),
  );

  common(
    program
      .command('search')
      .description('cherche dans les registres configurés')
      .argument('[termes...]', 'mots à chercher'),
  )
    .option('--registry <nom>', 'limite la recherche à un registre')
    .option('--tool <outil>', 'ne garde que les paquets compatibles avec cet outil')
    .action((terms: string[], opts: CommonOpts & { registry?: string }) =>
      exec<SearchData>('search', opts, async () => {
        const ctx = contextFor(opts);
        const config = await loadConfig(io.env);
        const query = terms.join(' ');
        const tool = parseTools(opts.tool)?.[0];
        const found = await searchRegistries(config.registries, query, registryContext(ctx), {
          ...(opts.registry ? { registry: opts.registry } : {}),
          ...(tool ? { tool } : {}),
        });
        const data: SearchData = { query, results: found.entries, failures: found.failures };
        const warnings: Warning[] = found.failures.map((f) => ({
          code: 'REGISTRY_FAILED',
          message: `${f.registry} : ${f.message}`,
        }));
        if (config.registries.length === 0)
          warnings.push({
            code: 'NO_REGISTRY',
            message: 'aucun registre configuré : « ahub registry add <url> »',
          });
        return { data, warnings, human: render.search(data) };
      }),
    );

  common(
    program
      .command('info')
      .description('montre le contenu d’un paquet sans l’installer')
      .argument('<paquet>', 'propriétaire/dépôt[@tag|#ref], URL, chemin ou nom[@registre]'),
  )
    .option('--files', 'inclut le texte des fichiers')
    .action((pkg: string, opts: CommonOpts & { files?: boolean }) =>
      exec<InfoData>('info', opts, async () => {
        const ctx = contextFor(opts);
        const ref = await resolvePackageArg(pkg, ctx);
        const i = await inspectPackage(ctx, canonicalDepString(ref), { includeText: opts.files === true });
        const s = i.summary;
        const data: InfoData = {
          dep: i.dep,
          identity: i.identity,
          name: s.name,
          layout: s.layout,
          contents: {
            skills: s.skills.map((x) => x.name),
            agents: s.agents,
            commands: s.commands,
            instructions: s.instructions,
            hooks: s.hooks.map((h) => h.name),
            mcpServers: s.mcpServers.map((m) => m.name),
          },
          mcpServers: s.mcpServers,
          dependencies: i.dependencies,
          files: i.files,
          scan: { blocked: i.blocked, summary: summarizeFindings(i.findings), findings: i.findings },
        };
        if (s.version) data.version = s.version;
        if (s.description) data.description = s.description;
        if (s.license) data.license = s.license;
        if (i.commit) data.commit = i.commit;
        if (i.resolvedTag) data.resolvedTag = i.resolvedTag;
        if (i.treeSha256) data.treeSha256 = i.treeSha256;
        return { data, warnings: i.diagnostics, human: render.info(data) };
      }),
    );

  common(
    program
      .command('scan')
      .description('analyse un dossier ou un paquet (Unicode caché, motifs suspects)')
      .argument('[cible]', 'dossier, fichier ou paquet distant', '.'),
  )
    .addOption(new Option('--format <format>', 'format de sortie').choices(['text', 'json', 'sarif']))
    .option('--output <fichier>', 'écrit le rapport dans un fichier')
    .action((target: string, opts: CommonOpts & { format?: string; output?: string }) =>
      exec<ScanCommandData>(
        'scan',
        { ...opts, json: opts.json === true || opts.format === 'json' },
        async () => {
          const ctx = contextFor(opts);
          const local = path.resolve(ctx.scope === 'user' ? io.cwd : ctx.root, target);
          let inputs: Array<{ path: string; bytes: Buffer }>;
          if (existsSync(local)) {
            const st = await lstat(local);
            inputs = st.isDirectory()
              ? await collectFiles(local)
              : [{ path: path.basename(local), bytes: await readFile(local) }];
          } else {
            const ref = await resolvePackageArg(target, ctx);
            const i = await inspectPackage(ctx, canonicalDepString(ref), { includeText: true });
            inputs = i.files
              .filter((f) => f.text !== undefined)
              .map((f) => ({ path: f.path, bytes: Buffer.from(f.text!, 'utf8') }));
          }
          const findings = scanFiles(inputs);
          const data: ScanCommandData = {
            target,
            filesScanned: inputs.length,
            blocked: hasBlocking(findings),
            summary: summarizeFindings(findings),
            findings,
          };
          const exit = data.blocked ? EXIT.SCAN_BLOCKED : EXIT.OK;
          if (opts.format === 'sarif') {
            const sarif = JSON.stringify(toSarif(findings, CLI_VERSION), null, 2);
            if (opts.output) {
              await writeFile(path.resolve(io.cwd, opts.output), sarif + '\n');
              return { data, human: `Rapport SARIF écrit : ${opts.output}`, exit };
            }
            return { data, raw: sarif, exit };
          }
          return { data, human: render.scan(data), exit };
        },
      ),
    );

  const registry = program
    .command('registry')
    .description('gère les registres (catalogues) consultés par search et add');

  common(
    registry
      .command('add')
      .description('ajoute un registre')
      .argument(
        '<url>',
        'URL d’un serveur Agenteca, dépôt git publiant un marketplace.json, ou dossier local',
      ),
  )
    .option('--name <nom>', 'nom du registre')
    .addOption(
      new Option('--kind <type>', 'type de registre (déduit de l’URL par défaut)').choices([
        'server',
        'git',
        'path',
      ]),
    )
    .action((url: string, opts: CommonOpts & { name?: string; kind?: RegistryConfig['kind'] }) =>
      exec<RegistryData>('registry add', opts, async () => {
        const ctx = contextFor(opts);
        const config = await loadConfig(io.env);
        const kind = opts.kind ?? inferRegistryKind(url);
        const reg: RegistryConfig = {
          name: opts.name ?? registryNameFromUrl(url),
          url: kind === 'path' ? path.resolve(io.cwd, url.replace(/^~\//, `${ctx.home}/`)) : url,
          kind,
        };
        if (config.registries.some((r) => r.name === reg.name))
          throw new AhubError(
            'USAGE',
            `un registre « ${reg.name} » existe déjà (choisissez un autre --name)`,
          );
        // Vérifié avant d'être enregistré : un registre illisible n'est pas ajouté.
        const { catalog } = await loadCatalog(reg, registryContext(ctx));
        config.registries.push(reg);
        await saveConfig(config, io.env);
        return { data: reg, human: `Registre « ${reg.name} » ajouté (${catalog.entries.length} paquet(s)).` };
      }),
    );

  common(registry.command('list').alias('ls').description('liste les registres configurés')).action(
    (opts: CommonOpts) =>
      exec<RegistryListData>('registry list', opts, async () => {
        const data: RegistryListData = { registries: (await loadConfig(io.env)).registries };
        return { data, human: render.registries(data) };
      }),
  );

  common(registry.command('remove').alias('rm').description('retire un registre').argument('<nom>')).action(
    (name: string, opts: CommonOpts) =>
      exec<RegistryData>('registry remove', opts, async () => {
        const config = await loadConfig(io.env);
        const reg = config.registries.find((r) => r.name === name);
        if (!reg) throw new AhubError('NOT_FOUND', `registre « ${name} » inconnu`);
        config.registries = config.registries.filter((r) => r.name !== name);
        await saveConfig(config, io.env);
        return { data: reg, human: `Registre « ${name} » retiré.` };
      }),
  );

  common(
    registry
      .command('export')
      .description('exporte un catalogue au format de marketplace natif d’un outil')
      .argument('<source>', 'nom d’un registre configuré, dossier local ou dépôt git'),
  )
    .addOption(
      new Option('--format <outil>', 'format cible')
        .choices(['claude', 'codex', 'copilot', 'cursor'])
        .makeOptionMandatory(),
    )
    .option('--out <dossier>', 'écrit le fichier dans ce dossier, à l’emplacement attendu par l’outil')
    .option('--all', 'inclut aussi les paquets qui ne sont pas des plugins natifs')
    .action((source: string, opts: CommonOpts & { format: MarketplaceFormat; out?: string; all?: boolean }) =>
      exec<RegistryExportData>('registry export', opts, async () => {
        const ctx = contextFor(opts);
        const config = await loadConfig(io.env);
        const reg: RegistryConfig = config.registries.find((r) => r.name === source) ?? {
          name: registryNameFromUrl(source),
          url: inferRegistryKind(source) === 'path' ? path.resolve(io.cwd, source) : source,
          kind: inferRegistryKind(source),
        };
        const { catalog, diagnostics } = await loadCatalog(reg, registryContext(ctx));
        const out = exportMarketplace(catalog, opts.format, { includeAll: opts.all === true });
        const data: RegistryExportData = {
          format: opts.format,
          path: out.path,
          written: false,
          entries: (out.json.plugins as unknown[]).length,
          marketplace: out.json,
        };
        if (opts.out) {
          const file = path.join(path.resolve(io.cwd, opts.out), ...out.path.split('/'));
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(out.json, null, 2) + '\n');
          data.written = true;
        }
        return {
          data,
          warnings: [...diagnostics, ...out.diagnostics],
          human: opts.out
            ? `Écrit : ${path.join(opts.out, out.path)} (${data.entries} entrée(s))`
            : JSON.stringify(out.json, null, 2),
        };
      }),
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      if (
        e.code === 'commander.helpDisplayed' ||
        e.code === 'commander.version' ||
        e.code === 'commander.help'
      )
        return EXIT.OK;
      const message = e.message.replace(/^error: /, '');
      if (wantsJson) {
        const envelope: Envelope = {
          schemaVersion: SCHEMA_VERSION,
          command: argv.find((a) => !a.startsWith('-')) ?? '',
          ok: false,
          data: null,
          warnings: [],
          error: { code: 'USAGE', message },
        };
        io.out(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        io.err(usageOutput || `${message}\n`);
      }
      return EXIT.USAGE;
    }
    throw e;
  }
  return exitCode;
}
