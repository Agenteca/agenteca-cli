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
  /** Path or name of the binary (default: `ahub`, looked up in the PATH). */
  bin?: string;
  /** Prefix arguments, for example `['/path/to/bin.js']` when `bin` is `node`. */
  binArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ChangeOptions {
  tools?: Tool[];
  global?: boolean;
  allowUnsafe?: boolean;
  /** Conflicting paths that the user agrees to overwrite. */
  overwrite?: string[];
}

/** Transport error: the binary cannot be found or its output is not a valid envelope. */
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
 * Minimal client of `ahub --json`, with no dependency but Node.
 * The extensions (MCP, VS Code…) all go through it: the logic stays in the CLI.
 *
 * An `ok: false` envelope is not an exception: it is returned as
 * is, so that the caller reads `error.code` (for example `CONFIRMATION_REQUIRED`).
 */
export class AhubClient {
  constructor(private readonly options: AhubClientOptions = {}) {}

  /** Runs `ahub <args> --json` and returns the envelope. */
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
              new AhubClientError(`"${bin}" binary not found. Install the CLI: npm install -g @agenteca/cli`),
            );
          }
          let envelope: Envelope<T>;
          try {
            envelope = JSON.parse(stdout) as Envelope<T>;
          } catch {
            return reject(
              new AhubClientError(`unreadable ahub output${err ? ` (${err.message})` : ''}`, stdout, stderr),
            );
          }
          if (typeof envelope !== 'object' || envelope === null || typeof envelope.ok !== 'boolean') {
            return reject(new AhubClientError('unexpected ahub output: no envelope', stdout, stderr));
          }
          if (String(envelope.schemaVersion).split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
            return reject(
              new AhubClientError(
                `incompatible contract version: ahub speaks ${envelope.schemaVersion}, this client ${SCHEMA_VERSION}`,
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

  /** Computes the plan without writing anything. The returned `planHash` is then used by `apply`. */
  plan(
    kind: 'add' | 'install' | 'update' | 'remove',
    packages: string[] = [],
    o: ChangeOptions = {},
  ): Promise<Envelope<ChangeData>> {
    return this.run([kind, ...packages, '--dry-run', ...this.changeArgs(o)]);
  }

  /** Applies a plan already shown to the user; refused (`PLAN_CHANGED`) if the content changed in between. */
  apply(
    kind: 'add' | 'install' | 'update' | 'remove',
    packages: string[],
    planHash: string,
    o: ChangeOptions = {},
  ): Promise<Envelope<ChangeData>> {
    return this.run([kind, ...packages, '--yes', '--expect-plan', planHash, ...this.changeArgs(o)]);
  }
}
