import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The test of the real binary needs dist/: it is compiled once before the suite. */
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(
    process.execPath,
    [path.resolve(root, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}
