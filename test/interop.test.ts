import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChangeData, ListData } from '../src/types.js';
import { cleanupTmp, listTree, sandbox, writeTree } from './helpers.js';

/**
 * Interoperability with the reference tool `apm` (Microsoft APM).
 *
 * These tests only run if AHUB_INTEROP_APM points to the `apm` binary
 * (pinned version: 0.35.0). They are offline: the package is local.
 *
 *   python3 -m venv .venv && .venv/bin/pip install apm-cli==0.35.0
 *   AHUB_INTEROP_APM=$PWD/.venv/bin/apm npm test
 */
const APM = process.env.AHUB_INTEROP_APM;
const exec = promisify(execFile);
afterAll(cleanupTmp);

const LOCAL_PKG = {
  'local-pkg/apm.yml': 'name: local-pkg\nversion: 1.0.0\ndescription: Paquet local\n',
  'local-pkg/.apm/skills/hello/SKILL.md': '---\nname: hello\ndescription: Dit bonjour.\n---\n\nBonjour.\n',
  'local-pkg/.apm/agents/reviewer.agent.md': '---\ndescription: Relit.\n---\n\nTu relis.\n',
  '.claude/.keep': '',
};

async function apm(cwd: string, home: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec(APM!, args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, APM_NON_INTERACTIVE: '1' },
  });
  const output = `${stdout}${stderr}`;
  // apm 0.35.0 exits with code 0 even when it fails: its output is read instead.
  if (/\[x\]/.test(output)) throw new Error(`apm ${args.join(' ')} a échoué :\n${output}`);
  return output;
}

describe.skipIf(!APM)('interopérabilité avec apm 0.35.0', () => {
  it('apm accepts a project installed by ahub', async () => {
    const sb = await sandbox();
    await writeTree(sb.cwd, LOCAL_PKG);
    expect((await sb.json(['add', './local-pkg', '--tool', 'claude', '--yes'])).code).toBe(0);
    const out = await apm(sb.cwd, sb.home, ['install']);
    expect(out).toContain('Installed 1 APM dependency');
    const lock = await readFile(path.join(sb.cwd, 'apm.lock.yaml'), 'utf8');
    expect(lock).toContain('repo_url: _local/local-pkg');
  });

  it('ahub reads and replays a project installed by apm, then apm still accepts it', async () => {
    const sb = await sandbox();
    await writeTree(sb.cwd, {
      ...LOCAL_PKG,
      'apm.yml':
        'name: proj\nversion: 0.1.0\ntargets:\n  - claude\ndependencies:\n  apm:\n    - ./local-pkg\n',
    });
    await apm(sb.cwd, sb.home, ['install']);

    const list = await sb.json<ListData>(['list']);
    expect(list.envelope.data!.packages[0]).toMatchObject({
      name: 'local-pkg',
      version: '1.0.0',
      source: 'local',
    });

    const replay = await sb.json<ChangeData>(['install', '--yes']);
    expect(replay.code).toBe(0);
    // Both tools deploy the same paths; only the content of the agent differs (ahub adds `name:`).
    expect(replay.envelope.data!.files.map((f) => [f.path, f.action])).toEqual([
      ['.claude/agents/reviewer.md', 'update'],
      ['.claude/skills/hello/SKILL.md', 'unchanged'],
    ]);
    expect(await apm(sb.cwd, sb.home, ['install'])).toContain('Installed 1 APM dependency');

    expect((await sb.json(['remove', 'local-pkg', '--yes'])).code).toBe(0);
    expect((await listTree(sb.cwd)).filter((f) => f.startsWith('.claude/') && f !== '.claude/.keep')).toEqual(
      [],
    );
  });
});
