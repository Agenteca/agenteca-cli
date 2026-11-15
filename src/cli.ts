import {
  AHUB_VERSION,
  AhubError,
  applyInstall,
  canonicalDepString,
  createContext,
  type DepRef,
  detectLocale,
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
  type Locale,
  LOCALES,
  ManifestFile,
  type MarketplaceFormat,
  parseCliPackageArg,
  parseDepString,
  parseLocale,
  type PreparedInstall,
  prepareInstall,
  type ProjectContext,
  type RegistryConfig,
  registryNameFromUrl,
  saveConfig,
  scanFiles,
  searchRegistries,
  setLocale,
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
import { t } from './i18n.js';

/** Injectable input and output: the CLI is tested without starting a process. */
export interface IO {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  /** Asks a question and returns the answer; absent outside a terminal. */
  ask?(question: string): Promise<string>;
}

interface Outcome<T> {
  data: T | null;
  warnings?: Warning[];
  human?: string;
  error?: ErrorInfo;
  /** Raw output instead of the envelope (SARIF report). */
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
    const name = raw === 'vscode' ? 'copilot' : raw;
    if (name === 'all') return [...SUPPORTED_TARGETS];
    if (!(SUPPORTED_TARGETS as readonly string[]).includes(name)) {
      throw new AhubError(
        'USAGE',
        t('unknown tool "{0}". Values: {1}, all.', [raw, SUPPORTED_TARGETS.join(', ')]),
      );
    }
    if (!out.includes(name as Target)) out.push(name as Target);
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

/** Walks a folder for the scan, without following symbolic links. */
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

/**
 * Language of the messages: `--lang <code>` first, then AHUB_LANG and the usual locale variables.
 * Read before the commands are declared, because their help texts are translated too.
 */
function requestedLocale(argv: string[], env: NodeJS.ProcessEnv): Locale {
  const i = argv.findIndex((a) => a === '--lang' || a.startsWith('--lang='));
  if (i >= 0) {
    const value = argv[i]!.includes('=') ? argv[i]!.slice('--lang='.length) : argv[i + 1];
    const locale = parseLocale(value);
    if (locale) return locale;
  }
  return detectLocale(env);
}

/** Entry point of the CLI. Returns the exit code. */
export async function run(argv: string[], io: IO): Promise<number> {
  setLocale(requestedLocale(argv, io.env));
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
      if (o.error) io.err(t('Error: {0}\n', [o.error.message]));
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
    /^(y|yes|o|oui|s|si|sí|是|हाँ)$/i.test((await io.ask!(t('{0} [y/N] ', [question]))).trim());

  /** Turns an argument of `add` into a dependency, going through the registries if needed. */
  const resolvePackageArg = async (arg: string, ctx: ProjectContext): Promise<DepRef> => {
    const parsed = parseCliPackageArg(arg);
    if (parsed.type === 'dep') return parseDepString(parsed.dep);
    const config = await loadConfig(io.env);
    if (config.registries.length === 0) {
      throw new AhubError(
        'NOT_FOUND',
        t(
          '"{0}" looks like a catalog name, but no registry is configured. Use owner/repo, or "ahub registry add <url>".',
          [arg],
        ),
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
      const failed = found.failures.map((f) => `${f.registry}: ${f.message}`).join('; ');
      throw new AhubError(
        'NOT_FOUND',
        (parsed.registry
          ? t('no package "{0}" in registry "{1}"', [parsed.name, parsed.registry])
          : t('no package "{0}" in the configured registries', [parsed.name])) +
          (failed ? t(' (failed registries: {0})', [failed]) : ''),
      );
    }
    if (matches.length > 1) {
      throw new AhubError(
        'USAGE',
        t('"{0}" exists in several registries: {1}. Specify name@registry.', [
          parsed.name,
          matches.map((m) => `${m.name}@${m.registry}`).join(', '),
        ]),
      );
    }
    return parseDepString(matches[0]!.source);
  };

  /** Flow shared by add, install, update and remove: plan, safeguards, confirmation, application. */
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
        return { data, warnings, human: t('{0}\nDry run: nothing was written.', [render.plan(data)]) };
      }
      if (opts.expectPlan && opts.expectPlan !== prepared.planHash) {
        return stop({
          code: 'PLAN_CHANGED',
          message: t(
            'the content changed since the approved plan: run again with --dry-run to see the new plan',
          ),
        });
      }
      if (prepared.blocked && !opts.allowUnsafe) {
        return stop({
          code: 'SCAN_BLOCKED',
          message: t(
            'the security scan found {0} critical finding(s): nothing was written. Explicit override: --allow-unsafe',
            [data.scan.summary.critical],
          ),
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
            if (await yes(t('{0}. Overwrite or delete it?', [c.message]))) overwrite.add(c.path);
          }
        }
        if (uncovered().length > 0) {
          return stop(
            {
              code: 'FILE_MODIFIED',
              message: t(
                '{0} file(s) edited by hand or unmanaged: nothing was written. Explicit agreement: --overwrite <path> (or --force for all)',
                [uncovered().length],
              ),
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
              message: t('confirmation required: run again with --yes (after a --dry-run to read the plan)'),
            },
            '',
          );
        }
        if (!(await yes(t('Apply these changes?')))) {
          return stop({ code: 'CONFIRMATION_REQUIRED', message: t('cancelled: nothing was written') }, '');
        }
      }

      const result = await applyInstall(prepared, {
        overwrite: opts.force ? 'all' : overwrite,
        ...(opts.allowUnsafe ? { allowUnsafe: true } : {}),
      });
      data.applied = true;
      data.result = { written: result.written, removed: result.removed, skipped: result.skipped };
      return {
        data,
        warnings,
        human: changed ? render.applied(data) : t('Everything is up to date: nothing to do.'),
      };
    });

  const program = new Command('ahub')
    .description(t('Catalog and manager of AI agents for Claude Code, Codex, GitHub Copilot and Cursor'))
    .version(CLI_VERSION, '-V, --version', t('show the version'))
    .helpOption('-h, --help', t('show help'))
    .helpCommand('help [command]', t('show help for a command'))
    .addOption(
      new Option('--lang <code>', t('language of the messages (default: from the environment)')).choices([
        ...LOCALES,
      ]),
    )
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => (usageOutput += s) });

  const common = (cmd: Command): Command =>
    cmd
      .option('--json', t('stable JSON output (contract schemas/cli-output.v1.schema.json)'))
      .addOption(
        new Option('--lang <code>', t('language of the messages (default: from the environment)')).choices([
          ...LOCALES,
        ]),
      )
      .option('--cwd <folder>', t('project folder (default: current folder)'))
      .helpOption('-h, --help', t('show help'));
  const scoped = (cmd: Command): Command =>
    common(cmd).option('-g, --global', t('user scope (~/.apm) instead of the project'));
  const changing = (cmd: Command): Command =>
    scoped(cmd)
      .addOption(
        new Option('--tool <liste>', t('target tools, comma-separated: claude, codex, copilot, cursor, all')),
      )
      .addOption(new Option('--target <liste>', t('alias of --tool')).hideHelp())
      .option('-y, --yes', t('apply without asking for confirmation'))
      .option('--dry-run', t('compute and show the plan without writing anything'))
      .option('--expect-plan <hash>', t('apply only if the plan has this hash (planHash from a --dry-run)'))
      .option('--allow-unsafe', t('deploy despite critical security findings'))
      .option(
        '--overwrite <path>',
        t('agree to overwrite or delete this edited file (repeatable)'),
        (v: string, acc: string[]) => [...acc, v],
        [] as string[],
      )
      .option('--force', t('agree to overwrite or delete every edited file'))
      .option(
        '--legacy-skill-paths',
        t('write skills to .github/skills and .cursor/skills instead of .agents/skills'),
      );
  const withTool = <T extends ChangeOpts & { target?: string }>(o: T): T => {
    if (!o.tool && o.target) o.tool = o.target;
    return o;
  };

  common(
    program.command('version').description(t('show the versions of the CLI and of the JSON contract')),
  ).action((opts: CommonOpts) =>
    exec<VersionData>('version', opts, async () => {
      const data: VersionData = {
        version: CLI_VERSION,
        schemaVersion: SCHEMA_VERSION,
        coreVersion: AHUB_VERSION,
        node: process.version,
      };
      return {
        data,
        human: t('ahub {0} (JSON contract {1}, core {2}, Node {3})', [
          data.version,
          data.schemaVersion,
          data.coreVersion,
          data.node,
        ]),
      };
    }),
  );

  scoped(program.command('init').description(t('create the apm.yml manifest')))
    .option('--name <name>', t('project name (default: folder name)'))
    .option('--tool <liste>', t('target tools to declare in the manifest'))
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
          return { data, human: t('{0} already exists: unchanged.', [ctx.manifestPath]) };
        }
        const targets = parseTools(opts.tool) ?? detectTargets(ctx.root, ctx.scope);
        const name = opts.name ?? (ctx.scope === 'user' ? 'global' : path.basename(ctx.root));
        const mf = ManifestFile.create({ name, ...(targets.length > 0 ? { targets } : {}) });
        await mkdir(path.dirname(ctx.manifestPath), { recursive: true });
        await writeFile(ctx.manifestPath, mf.toString());
        const data: InitData = { manifestPath: ctx.manifestPath, name, targets, created: true };
        return {
          data,
          human: t('Created: {0}\nTarget tools: {1}', [
            ctx.manifestPath,
            targets.length > 0 ? targets.join(', ') : t('none detected — name --tool when installing'),
          ]),
        };
      }),
    );

  changing(
    program
      .command('add')
      .description(t('add one or more packages and install them'))
      .argument('<package...>', t('owner/repo[@tag|#ref], git URL, local path, or name[@registry]')),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('add', withTool(opts), async (ctx) => {
      const add: DepRef[] = [];
      for (const p of pkgs) add.push(await resolvePackageArg(p, ctx));
      return { add, initName: ctx.scope === 'user' ? 'global' : path.basename(ctx.root) };
    }),
  );

  changing(
    program.command('install').description(t('install what the manifest describes, replaying the lockfile')),
  )
    .option('--frozen', t('fail if the lockfile does not cover the manifest exactly (for CI)'))
    .action((opts: ChangeOpts) =>
      change('install', withTool(opts), async () => (opts.frozen ? { frozen: true } : {})),
    );

  changing(
    program
      .command('update')
      .description(t('update every package, or the ones named'))
      .argument('[package...]', t('packages to update')),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('update', withTool(opts), async () => ({ update: pkgs.length > 0 ? pkgs : 'all' })),
  );

  changing(
    program
      .command('remove')
      .alias('rm')
      .description(t('remove packages and all their files'))
      .argument('<package...>', t('packages to remove')),
  ).action((pkgs: string[], opts: ChangeOpts) =>
    change('remove', withTool(opts), async () => ({ remove: pkgs })),
  );

  scoped(program.command('list').alias('ls').description(t('list installed packages'))).action(
    (opts: CommonOpts) =>
      exec<ListData>('list', opts, async () => {
        const ctx = contextFor(opts);
        const data: ListData = { scope: ctx.scope, packages: listInstalled(await loadLock(ctx)) };
        return { data, human: render.list(data) };
      }),
  );

  scoped(program.command('outdated').description(t('list available updates'))).action((opts: CommonOpts) =>
    exec<OutdatedData>('outdated', opts, async () => {
      const data: OutdatedData = { packages: await listOutdated(contextFor(opts)) };
      return { data, human: render.outdated(data) };
    }),
  );

  common(
    program
      .command('search')
      .description(t('search the configured registries'))
      .argument('[terms...]', t('words to search for')),
  )
    .option('--registry <name>', t('limit the search to one registry'))
    .option('--tool <outil>', t('keep only the packages compatible with this tool'))
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
            message: t('no registry configured: "ahub registry add <url>"'),
          });
        return { data, warnings, human: render.search(data) };
      }),
    );

  common(
    program
      .command('info')
      .description(t('show the content of a package without installing it'))
      .argument('<package>', t('owner/repo[@tag|#ref], URL, path or name[@registry]')),
  )
    .option('--files', t('include the text of the files'))
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
      .description(t('scan a folder or a package (hidden Unicode, suspicious patterns)'))
      .argument('[target]', t('folder, file or remote package'), '.'),
  )
    .addOption(new Option('--format <format>', t('output format')).choices(['text', 'json', 'sarif']))
    .option('--output <file>', t('write the report to a file'))
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
              return { data, human: t('SARIF report written: {0}', [opts.output]), exit };
            }
            return { data, raw: sarif, exit };
          }
          return { data, human: render.scan(data), exit };
        },
      ),
    );

  const registry = program
    .command('registry')
    .description(t('manage the registries (catalogs) used by search and add'));

  common(
    registry
      .command('add')
      .description(t('add a registry'))
      .argument(
        '<url>',
        t('URL of an Agenteca server, git repository publishing a marketplace.json, or local folder'),
      ),
  )
    .option('--name <name>', t('registry name'))
    .addOption(
      new Option('--kind <type>', t('registry type (inferred from the URL by default)')).choices([
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
            t('a registry "{0}" already exists (choose another --name)', [reg.name]),
          );
        // Checked before being recorded: an unreadable registry is not added.
        const { catalog } = await loadCatalog(reg, registryContext(ctx));
        config.registries.push(reg);
        await saveConfig(config, io.env);
        return {
          data: reg,
          human: t('Registry "{0}" added ({1} package(s)).', [reg.name, catalog.entries.length]),
        };
      }),
    );

  common(registry.command('list').alias('ls').description(t('list the configured registries'))).action(
    (opts: CommonOpts) =>
      exec<RegistryListData>('registry list', opts, async () => {
        const data: RegistryListData = { registries: (await loadConfig(io.env)).registries };
        return { data, human: render.registries(data) };
      }),
  );

  common(
    registry.command('remove').alias('rm').description(t('remove a registry')).argument('<name>'),
  ).action((name: string, opts: CommonOpts) =>
    exec<RegistryData>('registry remove', opts, async () => {
      const config = await loadConfig(io.env);
      const reg = config.registries.find((r) => r.name === name);
      if (!reg) throw new AhubError('NOT_FOUND', t('unknown registry "{0}"', [name]));
      config.registries = config.registries.filter((r) => r.name !== name);
      await saveConfig(config, io.env);
      return { data: reg, human: t('Registry "{0}" removed.', [name]) };
    }),
  );

  common(
    registry
      .command('export')
      .description(t('export a catalog in the native marketplace format of a tool'))
      .argument('<source>', t('name of a configured registry, local folder or git repository')),
  )
    .addOption(
      new Option('--format <outil>', t('target format'))
        .choices(['claude', 'codex', 'copilot', 'cursor'])
        .makeOptionMandatory(),
    )
    .option('--out <folder>', t('write the file in this folder, where the tool expects it'))
    .option('--all', t('also include the packages that are not native plugins'))
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
            ? t('Written: {0} ({1} entries)', [path.join(opts.out, out.path), data.entries])
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
