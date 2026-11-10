import { execFile } from 'node:child_process';
import type {
  ChangeData,
  Envelope,
  InfoData,
  ListData,
  OutdatedData,
  RegistryListData,
  ScanCommandData,
  SearchData,
  Tool,
  VersionData,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';

export * from './types.js';

export interface AhubClientOptions {
  /** Chemin ou nom du binaire (défaut : `ahub`, cherché dans le PATH). */
  bin?: string;
  /** Arguments préfixes, par exemple `['/chemin/vers/bin.js']` quand `bin` vaut `node`. */
  binArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ChangeOptions {
  tools?: Tool[];
  global?: boolean;
  allowUnsafe?: boolean;
  /** Chemins en conflit que l'utilisateur accepte d'écraser. */
  overwrite?: string[];
}

/** Erreur de transport : le binaire est introuvable ou sa sortie n'est pas une enveloppe valide. */
export class AhubClientError extends Error {
  constructor(
    message: string,
    readonly stdout?: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'AhubClientError';
  }
}

/**
 * Client minimal de `ahub --json`, sans autre dépendance que Node.
 * Les extensions (MCP, VS Code…) passent toutes par lui : la logique reste dans la CLI.
 *
 * Une enveloppe `ok: false` n'est pas une exception : elle est retournée telle
 * quelle, pour que l'appelant lise `error.code` (par exemple `CONFIRMATION_REQUIRED`).
 */
export class AhubClient {
  constructor(private readonly options: AhubClientOptions = {}) {}

  /** Exécute `ahub <args> --json` et retourne l'enveloppe. */
  run<T>(args: string[], opts: { cwd?: string } = {}): Promise<Envelope<T>> {
    const bin = this.options.bin ?? 'ahub';
    const fullArgs = [...(this.options.binArgs ?? []), ...args, '--json'];
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        fullArgs,
        {
          cwd: opts.cwd ?? this.options.cwd,
          env: this.options.env ?? process.env,
          timeout: this.options.timeoutMs ?? 120_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(
              new AhubClientError(
                `binaire « ${bin} » introuvable. Installez la CLI : npm install -g @agenteca/cli`,
              ),
            );
          }
          let envelope: Envelope<T>;
          try {
            envelope = JSON.parse(stdout) as Envelope<T>;
          } catch {
            return reject(
              new AhubClientError(
                `sortie de ahub illisible${err ? ` (${err.message})` : ''}`,
                stdout,
                stderr,
              ),
            );
          }
          if (typeof envelope !== 'object' || envelope === null || typeof envelope.ok !== 'boolean') {
            return reject(
              new AhubClientError('sortie de ahub inattendue : enveloppe absente', stdout, stderr),
            );
          }
          if (String(envelope.schemaVersion).split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
            return reject(
              new AhubClientError(
                `version de contrat incompatible : ahub parle ${envelope.schemaVersion}, ce client ${SCHEMA_VERSION}`,
              ),
            );
          }
          resolve(envelope);
        },
      );
    });
  }

  private changeArgs(o: ChangeOptions = {}): string[] {
    const a: string[] = [];
    if (o.tools && o.tools.length > 0) a.push('--tool', o.tools.join(','));
    if (o.global) a.push('--global');
    if (o.allowUnsafe) a.push('--allow-unsafe');
    for (const p of o.overwrite ?? []) a.push('--overwrite', p);
    return a;
  }

  version(): Promise<Envelope<VersionData>> {
    return this.run(['version']);
  }

  search(query: string, o: { registry?: string; tool?: Tool } = {}): Promise<Envelope<SearchData>> {
    const a = ['search', query];
    if (o.registry) a.push('--registry', o.registry);
    if (o.tool) a.push('--tool', o.tool);
    return this.run(a);
  }

  info(pkg: string, o: { files?: boolean } = {}): Promise<Envelope<InfoData>> {
    return this.run(o.files ? ['info', pkg, '--files'] : ['info', pkg]);
  }

  list(o: { global?: boolean } = {}): Promise<Envelope<ListData>> {
    return this.run(o.global ? ['list', '--global'] : ['list']);
  }

  outdated(o: { global?: boolean } = {}): Promise<Envelope<OutdatedData>> {
    return this.run(o.global ? ['outdated', '--global'] : ['outdated']);
  }

  registries(): Promise<Envelope<RegistryListData>> {
    return this.run(['registry', 'list']);
  }

  scan(target: string): Promise<Envelope<ScanCommandData>> {
    return this.run(['scan', target]);
  }

  /** Calcule le plan sans rien écrire. Le `planHash` retourné sert ensuite à `apply`. */
  plan(
    kind: 'add' | 'install' | 'update' | 'remove',
    packages: string[] = [],
    o: ChangeOptions = {},
  ): Promise<Envelope<ChangeData>> {
    return this.run([kind, ...packages, '--dry-run', ...this.changeArgs(o)]);
  }

  /** Applique un plan déjà montré à l'utilisateur ; refusé (`PLAN_CHANGED`) si le contenu a changé entre-temps. */
  apply(
    kind: 'add' | 'install' | 'update' | 'remove',
    packages: string[],
    planHash: string,
    o: ChangeOptions = {},
  ): Promise<Envelope<ChangeData>> {
    return this.run([kind, ...packages, '--yes', '--expect-plan', planHash, ...this.changeArgs(o)]);
  }
}
