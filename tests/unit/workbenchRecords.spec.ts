import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TenantWorkspace } from '../../lib/tenant';

const dir=mkdtempSync(path.join(tmpdir(),'particl-workbench-records-'));
process.env.PLATFORM_DATABASE_URL=`file:${path.join(dir,'platform.db')}`;
process.env.TURSO_DATABASE_URL=`file:${path.join(dir,'primary.db')}`;
process.env.KEYRING_SECRET??='unit-test-keyring-secret-unit-test-keyring';
function workspace(name:string):TenantWorkspace{return {id:'ws_'+name,slug:name,name,legacy:true,dbUrl:`file:${path.join(dir,name+'.db')}`,dbToken:null,keys:{},usesPlatformKeys:false,allowanceUsd:null,gatewayKeyId:null,ownerId:'owner',createdAt:0,suspendedAt:null,suspendedReason:null,flaggedAt:null,flagNote:null,concurrency:null,rendersPerHour:null,storageQuotaBytes:null,deletedAt:null};}

test('private drafts are isolated by owner and tenant, with explicit stable production mappings',async()=>{
 const {saveDraft,readDraft}=await import('../../lib/workbench/records');
 const {newProject}=await import('../../lib/workbench/studio');
 const {runInTenant}=await import('../../lib/tenant');
 const p={...newProject('Private'),id:'same-draft-id'};
 let first='';
 await runInTenant(workspace('private'),async()=>{
  const a=await saveDraft('user-a',{...p,brief:'A private brief'},0);first=a.productionProjectId;
  expect(await readDraft('user-b',p.id)).toBeNull();
  const b=await saveDraft('user-b',{...p,brief:'B private brief'},0);
  expect(b.productionProjectId).not.toBe(a.productionProjectId);
  expect((await readDraft('user-a',p.id))?.project.brief).toBe('A private brief');
 });
 await runInTenant(workspace('other-tenant'),async()=>{
  expect(await readDraft('user-a',p.id)).toBeNull();
  const c=await saveDraft('user-a',p,0);expect(c.productionProjectId).not.toBe(first);
  await expect(saveDraft('user-b',{...p,id:'foreign',productionProjectId:first},0)).rejects.toThrow(/workspace/);
 });
});

test('concurrent creation and revision updates accept one winner without duplicate productions',async()=>{
 const {saveDraft,readDraft}=await import('../../lib/workbench/records');
 const {newProject}=await import('../../lib/workbench/studio');
 const {runInTenant}=await import('../../lib/tenant');const {db}=await import('../../lib/db');
 await runInTenant(workspace('compare-swap'),async()=>{
  const p={...newProject('Original'),id:'race'};
  const created=await Promise.allSettled([saveDraft('owner',{...p,name:'A'},0),saveDraft('owner',{...p,name:'B'},0)]);
  expect(created.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect(Number((await db().execute('SELECT COUNT(*) AS n FROM projects')).rows[0].n)).toBe(1);
  const saved=(await readDraft('owner',p.id))!;expect(saved.revision).toBe(1);
  const updated=await Promise.allSettled([saveDraft('owner',{...saved.project,name:'First',brief:'First'},1),saveDraft('owner',{...saved.project,name:'Second',brief:'Second'},1)]);
  expect(updated.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const final=(await readDraft('owner',p.id))!;expect(final.revision).toBe(2);expect(final.project.name).toBe(final.project.brief);
  await expect(saveDraft('owner',{...p,name:'Stale'},0)).rejects.toThrow(/another window/);
 });
});

test('shot mapping is stable, collaborator-specific, and ignores client-forged mapping values',async()=>{
 const {saveDraft,readDraft,mapNodeShot}=await import('../../lib/workbench/records');
 const {newProject}=await import('../../lib/workbench/studio');const {runInTenant}=await import('../../lib/tenant');const {db}=await import('../../lib/db');
 await runInTenant(workspace('mapping'),async()=>{
  const p={...newProject('Shots'),nodes:[{id:'node-one',title:'An arrival',type:'scene' as const,x:0,y:0,width:200,linked:[]}]};
  const first=await saveDraft('a',p,0);const saved=(await readDraft('a',p.id))!.project;
  const ids=await Promise.all([mapNodeShot('a',saved,'node-one'),mapNodeShot('a',saved,'node-one')]);expect(ids[0]).toBe(ids[1]);
  expect((await readDraft('a',p.id))?.project.shotMappings?.['node-one']).toBe(ids[0]);
  expect((await readDraft('a',p.id))?.revision).toBe(1); // Mapping is recoverable without another draft PUT.
  const second=await saveDraft('a',{...saved,shotMappings:{'node-one':'forged-id'}},1);expect(second.shotMappings['node-one']).toBe(ids[0]);
  const shared={...p,id:'other-draft',productionProjectId:first.productionProjectId};await saveDraft('b',shared,0);
  const other=await mapNodeShot('b',shared,'node-one');expect(other).not.toBe(ids[0]);
  expect(Number((await db().execute('SELECT COUNT(*) AS n FROM shots')).rows[0].n)).toBe(2);
  const foreign=await saveDraft('a',{...newProject('Other')},0);
  await expect(saveDraft('a',{...saved,productionProjectId:foreign.productionProjectId},2)).rejects.toThrow(/cannot change/);
  await db().execute({sql:'DELETE FROM shots WHERE id=?',args:[ids[0]]});
  expect((await readDraft('a',p.id))?.project.shotMappings?.['node-one']).toBeUndefined();
  expect(await mapNodeShot('a',saved,'node-one')).toBe(ids[0]);
  expect(Number((await db().execute({sql:'SELECT COUNT(*) AS n FROM shots WHERE id=?',args:[ids[0]]})).rows[0].n)).toBe(1);
 });
});

test('shared bible versions are immutable while private drafts remain editable',async()=>{
 const {saveDraft,readDraft,publishBible}=await import('../../lib/workbench/records');const {seedProject}=await import('../../lib/workbench/studio');const {runInTenant}=await import('../../lib/tenant');const {db}=await import('../../lib/db');
 await runInTenant(workspace('bible'),async()=>{
  const p=seedProject();await saveDraft('author',p,0);
  await expect(publishBible('other','Other',p.id)).rejects.toThrow(/Save/);
  const v1=await publishBible('author','Author',p.id);expect(v1.version).toBe(1);
  const stored=String((await db().execute('SELECT body FROM workbench_bibles WHERE version=1')).rows[0].body);
  const draft=(await readDraft('author',p.id))!;
  await saveDraft('author',{...draft.project,brief:'New private idea',sharedAssets:[]},draft.revision);
  expect(String((await db().execute('SELECT body FROM workbench_bibles WHERE version=1')).rows[0].body)).toBe(stored);
  const versions=await Promise.all([publishBible('author','Author',p.id),publishBible('author','Author',p.id)]);
  expect(versions.map(v=>v.version).sort()).toEqual([2,3]);
  expect(JSON.parse(stored).brief).toBe(p.brief);expect(JSON.parse(stored).assets.length).toBeGreaterThan(0);
  expect(String((await db().execute('SELECT body FROM workbench_bibles WHERE version=1')).rows[0].body)).toBe(stored);
 });
});

test('only an uploader publication grants shared legacy media access within the same tenant',async()=>{
 const {findWorkbenchMedia}=await import('../../lib/workbench/media-records');
 const {workbenchReady}=await import('../../lib/workbench/records');const {runInTenant}=await import('../../lib/tenant');const {db}=await import('../../lib/db');
 await runInTenant(workspace('shared-media'),async()=>{
  await workbenchReady();
  await db().execute(`INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES('wb_private','alice','Private','image/png','png',1,'private','hash')`);
  expect(await findWorkbenchMedia('wb_private','alice')).not.toBeNull();
  expect(await findWorkbenchMedia('wb_private','bob')).toBeNull();
  const body=JSON.stringify({assets:[{url:'/api/workbench/media/wb_private'}]});
  await db().execute({sql:`INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES('project',1,'bob',?,0)`,args:[body]});
  expect(await findWorkbenchMedia('wb_private','bob')).toBeNull();
  await db().execute({sql:`INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES('project',2,'alice',?,0)`,args:[body]});
  expect(await findWorkbenchMedia('wb_private','bob')).not.toBeNull();
 });
 await runInTenant(workspace('unrelated-media'),async()=>{expect(await findWorkbenchMedia('wb_private','bob')).toBeNull();});
});
