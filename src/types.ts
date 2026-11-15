/**
 * Types of the `ahub --json` contract (schema: schemas/cli-output.v1.schema.json).
 * This file depends on no other module: it is shared by the CLI and
 * by the client used in the extensions.
 */

export const SCHEMA_VERSION = '1.0';

export type ErrorCode =
  | 'USAGE'
  | 'MANIFEST_INVALID'
  | 'LOCK_INVALID'
  | 'LOCK_MISMATCH'
  | 'NOT_FOUND'
  | 'RESOLUTION_FAILED'
  | 'GIT_FAILED'
  | 'PACKAGE_INVALID'
  | 'SCAN_BLOCKED'
  | 'FILE_MODIFIED'
  | 'CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'PLAN_CHANGED'
  | 'NO_TARGET'
  | 'UNSUPPORTED'
  | 'REGISTRY_FAILED'
  | 'INTERNAL';

/** Exit codes of the process. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  SCAN_BLOCKED: 3,
  CONFIRMATION_REQUIRED: 4,
  FILE_MODIFIED: 5,
} as const;

export interface Warning {
  code: string;
  message: string;
  path?: string;
}

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Enveloppe unique de toute sortie `--json`. */
export interface Envelope<T = unknown> {
  schemaVersion: string;
  command: string;
  ok: boolean;
  data: T | null;
  warnings: Warning[];
  error: ErrorInfo | null;
}

export type Tool = 'claude' | 'codex' | 'copilot' | 'cursor';
export type Severity = 'critical' | 'warning' | 'info';

export interface FindingData {
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface ScanData {
  blocked: boolean;
  summary: { critical: number; warning: number; info: number };
  findings: FindingData[];
}

export interface PackageContents {
  skills: string[];
  agents: string[];
  commands: string[];
  instructions: string[];
  hooks: string[];
  mcpServers: string[];
}

export interface PlannedPackage {
  identity: string;
  name: string;
  version?: string;
  source: 'git' | 'local';
  ref?: string;
  commit?: string;
  resolvedTag?: string;
  direct: boolean;
  change: 'added' | 'updated' | 'unchanged';
  previousCommit?: string;
  targets: Tool[];
  contents: PackageContents;
}

export interface PlannedFileData {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  reason?: 'modified' | 'unmanaged';
  primitive: string;
  targets: Tool[];
}

export interface PlannedRemovalData {
  path: string;
  action: 'remove' | 'conflict' | 'missing';
}

export interface ConfigFileData {
  path: string;
  kind: 'mcp' | 'hooks';
  action: 'create' | 'update' | 'unchanged' | 'delete';
  changes: string[];
  conflicts: string[];
}

export interface ExecutableData {
  kind: 'hook' | 'mcp';
  target: Tool;
  name: string;
  detail: string;
  command: string;
}

export interface ConflictData {
  path: string;
  reason: 'modified' | 'unmanaged' | 'merge';
  message: string;
}

/** Data of `add`, `install`, `update` and `remove`: the plan, then its result. */
export interface ChangeData {
  applied: boolean;
  dryRun: boolean;
  /** To pass back with `--expect-plan` to apply exactly what was shown. */
  planHash: string;
  scope: 'project' | 'user';
  targets: Tool[];
  packages: PlannedPackage[];
  removedPackages: string[];
  files: PlannedFileData[];
  removals: PlannedRemovalData[];
  configFiles: ConfigFileData[];
  executables: ExecutableData[];
  scan: ScanData;
  conflicts: ConflictData[];
  result?: { written: string[]; removed: string[]; skipped: string[] };
}

export interface InitData {
  manifestPath: string;
  name: string;
  targets: string[];
  created: boolean;
}

export interface InstalledPackageData {
  identity: string;
  name: string;
  version?: string;
  source: 'git' | 'local';
  ref?: string;
  commit?: string;
  resolvedTag?: string;
  direct: boolean;
  targets: string[];
  files: string[];
  mergedFiles: string[];
}

export interface ListData {
  scope: 'project' | 'user';
  packages: InstalledPackageData[];
}

export interface OutdatedPackageData {
  identity: string;
  name: string;
  current: string;
  wanted: string;
  latest: string;
  kind: 'semver' | 'literal' | 'none';
  outdated: boolean;
}

export interface OutdatedData {
  packages: OutdatedPackageData[];
}

export interface SearchResultData {
  name: string;
  registry: string;
  source: string;
  description?: string;
  version?: string;
  license?: string;
  tags?: string[];
  tools?: string[];
  nativePlugin?: boolean;
}

export interface SearchData {
  query: string;
  results: SearchResultData[];
  failures: Array<{ registry: string; message: string }>;
}

export interface InfoData {
  dep: string;
  identity: string;
  name: string;
  version?: string;
  description?: string;
  license?: string;
  layout: string;
  commit?: string;
  resolvedTag?: string;
  treeSha256?: string;
  contents: PackageContents;
  mcpServers: Array<{ name: string; transport?: string; command?: string; args?: string[]; url?: string }>;
  dependencies: string[];
  files: Array<{ path: string; size: number; text?: string }>;
  scan: ScanData;
}

export interface ScanCommandData extends ScanData {
  target: string;
  filesScanned: number;
}

export interface RegistryData {
  name: string;
  url: string;
  kind: 'server' | 'git' | 'path';
}

export interface RegistryListData {
  registries: RegistryData[];
}

export interface RegistryExportData {
  format: Tool;
  path: string;
  written: boolean;
  entries: number;
  marketplace: Record<string, unknown>;
}

export interface VersionData {
  version: string;
  schemaVersion: string;
  coreVersion: string;
  node: string;
}
