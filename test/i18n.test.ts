import { LOCALES, setLocale, t } from '@agenteca/core';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import '../src/i18n.js';
import { type IO, run } from '../src/cli.js';
import { cleanupTmp, sandbox } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

/** Every message passed as a literal to t() or msg() in the sources. */
function sourceMessages(): Set<string> {
  const found = new Set<string>();
  const call = /\b(?:t|msg)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts') || name === 'i18n.ts') continue;
    for (const m of readFileSync(path.join(srcDir, name), 'utf8').matchAll(call)) {
      found.add(m[1]!.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)));
    }
  }
  return found;
}

async function runCli(
  args: string[],
  sb: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: IO = {
    cwd: sb.cwd,
    env: sb.env,
    out: (s) => (stdout += s),
    err: (s) => (stderr += s),
    isTTY: false,
  };
  return { code: await run(args, io), stdout, stderr };
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
const readCatalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(srcDir, 'locales', `${locale}.json`), 'utf8')) as Record<string, string>;

describe('translations of the command line', () => {
  afterEach(async () => {
    setLocale('en');
    await cleanupTmp();
  });

  const messages = sourceMessages();
  const translated = LOCALES.filter((l) => l !== 'en');

  it('finds the messages of the sources', () => {
    expect(messages.size).toBeGreaterThan(100);
  });

  it.each(translated)('catalog %s translates every message and nothing else', (locale) => {
    const catalog = readCatalog(locale);
    const keys = Object.keys(catalog);
    expect(
      [...messages].filter((m) => !(m in catalog)),
      'messages with no translation',
    ).toEqual([]);
    expect(
      keys.filter((k) => !messages.has(k)),
      'translations of messages that no longer exist',
    ).toEqual([]);
    expect(keys).toEqual([...keys].sort());
    for (const [source, translation] of Object.entries(catalog)) {
      expect(translation.trim(), source).not.toBe('');
      expect(placeholders(translation), source).toEqual(placeholders(source));
      // A final line break is part of the layout: a translation keeps it.
      expect(/\n$/.test(translation), source).toBe(/\n$/.test(source));
    }
  });

  it('registers its catalogs next to those of the core', () => {
    setLocale('fr');
    expect(t('No package installed.')).toBe('Aucun paquet installé.');
    expect(t('empty string')).toBe('chaîne vide');
  });

  it('speaks English by default, and the language asked for otherwise', async () => {
    const sb = await sandbox();
    expect((await runCli(['list'], sb)).stdout).toBe('No package installed.\n');
    expect((await runCli(['list'], { ...sb, env: { ...sb.env, AHUB_LANG: 'fr' } })).stdout).toBe(
      'Aucun paquet installé.\n',
    );
    expect(
      (await runCli(['list'], { ...sb, env: { ...sb.env, AHUB_LANG: '', LANG: 'es_ES.UTF-8' } })).stdout,
    ).toBe('Ningún paquete instalado.\n');
    expect((await runCli(['list', '--lang', 'zh'], sb)).stdout).toBe('未安装任何包。\n');
    expect((await runCli(['--lang=hi', 'list'], sb)).stdout).toBe('कोई पैकेज इंस्टॉल नहीं है।\n');
  });

  it('translates the help and the error messages, never the error codes', async () => {
    const sb = await sandbox();
    const help = await runCli(['--help', '--lang', 'fr'], sb);
    expect(help.stdout).toContain('liste les paquets installés');
    const res = await runCli(['add', 'acme/x', '--tool', 'emacs', '--json', '--lang', 'es'], sb);
    const envelope = JSON.parse(res.stdout) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('USAGE');
    expect(envelope.error.message).toContain('herramienta desconocida');
  });
});
