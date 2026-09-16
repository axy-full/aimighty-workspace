import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RECOVERY_PROTOCOL } from '../../lib/recovery/control.mjs';
import type { CatalogModel } from '../../lib/catalog';

const directory = mkdtempSync(path.join(tmpdir(), 'particl-development-drain-'));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, 'platform.db')}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, 'primary.db')}`;
process.env.KEYRING_SECRET = 'development-drain-fixture-keyring-32-characters';
process.env.ENGINE_MOCK = '1';

for (const condition of ['queued-phase', 'started-phase', 'uncertain-phase', 'paused-workspace', 'interrupted-admission', 'paused-admission', 'paused-terminal'] as const) {
  test(`maintenance development drain preserves paid claims for ${condition}`, async () => {
    const { platformReady, platformDb, getWorkspace } = await import('../../lib/platform');
    const { ready, db } = await import('../../lib/db');
    const { runInTenant } = await import('../../lib/tenant');
    const { seedProject } = await import('../../lib/workbench/studio');
    const { prepareDevelopmentJob, quoteDevelopmentJob, runDevelopmentStep } = await import('../../lib/workbench/development-server');
    const { recoveryFence } = await import('../../lib/recovery');
    const { drainRecoveryJobs } = await import('../../lib/recoveryDrain');
    const { createPlatformDatabaseClient } = await import('../../lib/localDatabaseClient');
    const oldPlatformUrl = process.env.PLATFORM_DATABASE_URL;
    process.env.PLATFORM_DATABASE_URL = `file:${(await platformDb().execute("SELECT file FROM pragma_database_list WHERE name='main'")).rows[0].file}`;
    await platformReady();
    const workspaceId = 'ws_dev_drain_' + randomUUID(), owner = 'drain-owner-' + randomUUID();
    await platformDb().execute({ sql: `INSERT INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?, ?,0,0,'owner',0,0)`, args: [workspaceId, workspaceId, 'Development drain', `file:${path.join(directory, workspaceId + '.db')}`] });
    const ws = (await getWorkspace(workspaceId))!;
    const native = createPlatformDatabaseClient({ url: ws.dbUrl });
    const fixturePlatform = createClient({ url: process.env.PLATFORM_DATABASE_URL! });
    const model: CatalogModel = { id: 'anthropic/claude-sonnet-4.6', name: 'Claude fixture', owner: 'anthropic', type: 'language', description: '', contextWindow: 200000, maxTokens: 8192, pricing: { input: .0000001, output: .0000003 } };
    let jobId = '';
    await runInTenant(ws, async () => {
      await ready();
      const project = seedProject(); project.id = 'drain-development-' + randomUUID(); project.productionProjectId = 'production-' + randomUUID();
      const input = { projectId: project.id, requestId: randomUUID(), kind: 'idea' as const, model: model.id, effort: 'auto' };
      await db().execute({ sql: 'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)', args: [owner + ':' + project.id, owner, project.id, project.name, JSON.stringify(project), Date.now()] });
      const deps = { models: async () => [model], allowance: async () => ({ ok: true as const }) };
      const quote = await quoteDevelopmentJob(input, owner, deps);
      const prepared = await prepareDevelopmentJob({ ...input, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, maxUsd: quote.estimateUsd }, owner, undefined, deps);
      jobId = prepared.job.id;
      if (condition === 'started-phase' || condition === 'uncertain-phase') {
        await db().execute({ sql: 'UPDATE workbench_development_steps SET status=?,updated_at=? WHERE job_id=? AND step_index=0', args: [condition === 'started-phase' ? 'running' : 'uncertain', Date.now() - 400000, jobId] });
        if (condition === 'uncertain-phase') await db().execute({ sql: "UPDATE workbench_development_jobs SET status='uncertain' WHERE id=?", args: [jobId] });
      }
      if (condition === 'interrupted-admission' || condition === 'paused-admission') await db().execute({ sql: "UPDATE workbench_development_jobs SET status='queued',updated_at=? WHERE id=?", args: [Date.now() - 400000, jobId] });
      if (condition === 'paused-terminal') await db().execute({ sql: "UPDATE workbench_development_jobs SET status='failed',cost_usd=0.004,settled=0 WHERE id=?", args: [jobId] });
    });
    if (condition.startsWith('paused-')) await platformDb().execute({ sql: 'UPDATE workspaces SET suspended_at=? WHERE id=?', args: [Date.now(), workspaceId] });
    const fence = recoveryFence();
    await platformDb().execute({ sql: 'UPDATE recovery_intents SET created_at=? WHERE workspace_id=? AND id=?', args: [-Date.now(), workspaceId, jobId] });
    const controlOwner = 'development-drain-fixture-owner-0123456789';
    await fence.begin(controlOwner, { deployments: [{ id: 'local', protocol: RECOVERY_PROTOCOL }], oldDeploymentsStopped: true, externalWritersExcluded: true, evidence: 'Isolated local development fixtures with ENGINE_MOCK enabled; no provider network calls.' });
    try {
      const repetitions = condition === 'queued-phase' ? 3 : ['interrupted-admission', 'paused-admission', 'paused-terminal'].includes(condition) ? 1 : 2;
      for (let attempt = 0; attempt < repetitions; attempt++) {
        // Give this fixture's accepted intent the next fair queue slot only.
        await fixturePlatform.execute({ sql: 'DELETE FROM recovery_intent_attempts WHERE workspace_id=? AND id=?', args: [workspaceId, jobId] });
        const report = await drainRecoveryJobs(1);
        expect(report.attempted).toBe(1);
        expect(report.failed).toBe(condition === 'paused-workspace' ? 1 : 0);
        const steps = (await native.execute({ sql: 'SELECT status,response FROM workbench_development_steps WHERE job_id=? ORDER BY step_index', args: [jobId] })).rows;
        if (condition === 'queued-phase') {
          expect(steps.filter(row => row.status === 'succeeded')).toHaveLength(attempt + 1);
          expect(steps.filter(row => row.response != null)).toHaveLength(attempt + 1);
        } else expect(steps.every(row => row.response == null)).toBe(true);
      }
      const stored = (await native.execute({ sql: 'SELECT status,settled,cost_usd FROM workbench_development_jobs WHERE id=?', args: [jobId] })).rows[0];
      const meter = (await platformDb().execute({ sql: 'SELECT status,engine_cost_usd FROM meter_events WHERE id=?', args: [jobId] })).rows[0];
      if (condition === 'queued-phase') {
        expect(stored.status).toBe('succeeded'); expect(Number(stored.settled)).toBe(1); expect(meter.status).toBe('succeeded');
      } else if (condition === 'interrupted-admission' || condition === 'paused-admission') {
        expect(stored.status).toBe('failed'); expect(Number(stored.cost_usd)).toBe(0); expect(meter.status).toBe('failed'); expect(Number(meter.engine_cost_usd)).toBe(0);
        expect((await fence.status()).intents.some((row: { id: string }) => row.id === jobId)).toBe(false);
      } else if (condition === 'paused-terminal') {
        expect(stored.status).toBe('failed'); expect(Number(stored.settled)).toBe(1); expect(Number(stored.cost_usd)).toBe(.004);
        expect(meter.status).toBe('failed'); expect(Number(meter.engine_cost_usd)).toBe(.004);
        expect((await fence.status()).intents.some((row: { id: string }) => row.id === jobId)).toBe(false);
      } else {
        expect(stored.status).toBe(condition === 'uncertain-phase' ? 'uncertain' : 'running');
        expect((await fence.status()).intents.some((row: { id: string }) => row.id === jobId)).toBe(true);
      }
      expect((await fence.status()).activities.filter((row: { workspace_id: string }) => row.workspace_id === workspaceId)).toEqual([]);
    } finally {
      const state = await fence.status();
      if (state.state !== 'open') await fence.reopen(controlOwner, Number(state.epoch));
      fixturePlatform.close();
      process.env.PLATFORM_DATABASE_URL = oldPlatformUrl;
    }
    if (condition === 'interrupted-admission' || condition === 'paused-admission' || condition === 'paused-terminal') {
      await runInTenant(ws, () => runDevelopmentStep(jobId, owner));
      const replayed = (await native.execute({ sql: 'SELECT response FROM workbench_development_steps WHERE job_id=?', args: [jobId] })).rows;
      expect(replayed.every(row => row.response == null)).toBe(true);
      expect((await native.execute({ sql: 'SELECT status FROM workbench_development_jobs WHERE id=?', args: [jobId] })).rows[0].status).toBe('failed');
    }
  });
}
