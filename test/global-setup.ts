import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Le test du binaire réel a besoin de dist/ : on compile une fois avant la suite. */
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
