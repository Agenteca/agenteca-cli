import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AhubClient, AhubClientError } from '../src/client.js';
import { cleanupTmp, demoPackage, gitRepo, listTree, sandbox, validateEnvelope } from './helpers.js';

afterAll(cleanupTmp);
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

describe('client of the real binary (dist/bin.js)', () => {
  it('drives the plan → apply cycle through the ahub process', async () => {
    const repo = await gitRepo(demoPackage('1.0.0'), 'v1.0.0');
    const sb = await sandbox({ 'github.com/acme/demo-pack': repo });
    const client = new AhubClient({ bin: process.execPath, binArgs: [BIN], cwd: sb.cwd, env: sb.env });

    const version = await client.version();
    expect(validateEnvelope(version)).toBe(true);
    expect(version.data!.schemaVersion).toBe('1.0');

    const plan = await client.plan('add', ['acme/demo-pack@v1.0.0'], { tools: ['cursor'] });
    expect(validateEnvelope(plan)).toBe(true);
    expect(plan.ok).toBe(true);
    expect(await listTree(sb.cwd)).toEqual([]);

    const stale = await client.apply('add', ['acme/demo-pack@v1.0.0'], '0'.repeat(64), { tools: ['cursor'] });
    expect(stale.error?.code).toBe('PLAN_CHANGED');

    const applied = await client.apply('add', ['acme/demo-pack@v1.0.0'], plan.data!.planHash, {
      tools: ['cursor'],
    });
    expect(validateEnvelope(applied)).toBe(true);
    expect(applied.data!.applied).toBe(true);
    expect(await listTree(sb.cwd)).toContain('.cursor/agents/reviewer.md');

    expect((await client.list()).data!.packages.map((p) => p.name)).toEqual(['demo-pack']);
    expect((await client.outdated()).data!.packages[0]!.outdated).toBe(false);
    expect((await client.info('acme/demo-pack')).data!.contents.agents).toEqual(['reviewer']);
    expect((await client.registries()).data!.registries).toEqual([]);

    const removal = await client.plan('remove', ['demo-pack']);
    await client.apply('remove', ['demo-pack'], removal.data!.planHash);
    expect(await listTree(sb.cwd)).toEqual(['apm.lock.yaml', 'apm.yml']);
  });

  it('signale clairement un binaire introuvable', async () => {
    const client = new AhubClient({ bin: 'ahub-binaire-absent' });
    await expect(client.version()).rejects.toBeInstanceOf(AhubClientError);
    await expect(client.version()).rejects.toThrowError(/binary not found/);
  });
});
