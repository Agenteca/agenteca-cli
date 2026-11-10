import { git } from '@agenteca/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { type IO, run } from '../src/cli.js';
import type { Envelope } from '../src/types.js';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: false, allErrors: true });
export const validateEnvelope = ajv.compile(require('../schemas/cli-output.v1.schema.json') as object);

const created: string[] = [];
export async function tmpDir(prefix = 'ahub-cli-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
export async function cleanupTmp(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

const IDENT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
export async function commit(dir: string, files: Record<string, string>, tag?: string): Promise<string> {
  await writeTree(dir, files);
  await git(['add', '-A'], { cwd: dir });
  await git([...IDENT, 'commit', '-q', '--allow-empty', '-m', tag ?? 'commit'], { cwd: dir });
  if (tag) await git(['tag', tag], { cwd: dir });
  return (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
}
export async function gitRepo(files: Record<string, string>, tag?: string): Promise<string> {
  const dir = await tmpDir('ahub-cli-repo-');
  await git(['init', '-q', '-b', 'main'], { cwd: dir });
  await commit(dir, files, tag);
  return dir;
}

export async function listTree(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(dir, child)));
    else out.push(child);
  }
  return out.sort();
}

export function demoPackage(version = '1.0.0', extra: Record<string, string> = {}): Record<string, string> {
  return {
    'apm.yml': `name: demo-pack\nversion: ${version}\ndescription: Paquet de démonstration\nlicense: Apache-2.0\ndependencies:\n  mcp:\n    - name: demo-server\n      registry: false\n      transport: stdio\n      command: npx\n      args: ["-y", "@example/demo-mcp"]\n`,
    '.apm/skills/hello-skill/SKILL.md': `---\nname: hello-skill\ndescription: Dit bonjour (version ${version}).\n---\n\nSalue poliment.\n`,
    '.apm/agents/reviewer.agent.md': '---\ndescription: Relit le code.\n---\n\nTu relis le code avec soin.\n',
    '.apm/hooks/notify.json': JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fin' }] }] },
    }),
    ...extra,
  };
}

export interface Sandbox {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Exécute la CLI en mode texte. */
  text(
    args: string[],
    opts?: { isTTY?: boolean; answers?: string[] },
  ): Promise<{ code: number; out: string; err: string; questions: string[] }>;
  /** Exécute la CLI avec --json et valide la sortie contre le schéma du contrat. */
  json<T = any>(args: string[]): Promise<{ code: number; envelope: Envelope<T> }>;
}

export async function sandbox(mirrors: Record<string, string> = {}): Promise<Sandbox> {
  const cwd = await tmpDir('ahub-cli-project-');
  const home = await tmpDir('ahub-cli-home-');
  const cache = await tmpDir('ahub-cli-cache-');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    AHUB_HOME: home,
    AHUB_CACHE_DIR: cache,
    AHUB_GIT_MIRRORS: JSON.stringify(mirrors),
  };
  const text: Sandbox['text'] = async (args, opts = {}) => {
    let out = '';
    let err = '';
    const questions: string[] = [];
    const answers = [...(opts.answers ?? [])];
    const io: IO = { cwd, env, out: (s) => (out += s), err: (s) => (err += s), isTTY: opts.isTTY === true };
    if (opts.isTTY) {
      io.ask = async (q) => {
        questions.push(q);
        return answers.shift() ?? '';
      };
    }
    const code = await run(args, io);
    return { code, out, err, questions };
  };
  const json: Sandbox['json'] = async (args) => {
    const r = await text([...args, '--json']);
    let envelope: Envelope<any>;
    try {
      envelope = JSON.parse(r.out);
    } catch {
      throw new Error(`sortie non JSON pour « ${args.join(' ')} » :\n${r.out}\n${r.err}`);
    }
    expect(
      validateEnvelope(envelope),
      `${args.join(' ')} → ${JSON.stringify(validateEnvelope.errors, null, 1)}`,
    ).toBe(true);
    expect(r.err, 'rien ne doit être écrit sur stderr en mode --json').toBe('');
    return { code: r.code, envelope };
  };
  return { cwd, home, env, text, json };
}
