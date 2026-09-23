import { createHash } from 'node:crypto';
import { db, ready, now } from '@/lib/db';
import { requireTenant } from '@/lib/tenant';
import { getPlatformLayer, planOf } from '@/lib/platform';
import { creditsApply } from '@/lib/credits';
import { ceilingFor, ceilingMessage } from '@/lib/planLimits';
import { invalidate, PROJECTS_KEY } from '@/lib/cache';
import type { Project } from './studio';
import type { Client, Transaction } from '@libsql/client';
import {publishedContext} from './published-context';
import {referencedMedia} from '@/lib/mediaBindings';

const initialized = new WeakMap<Client, Promise<void>>();
export async function workbenchReady() {
  await ready();
  const client=db();
  if(!initialized.has(client))initialized.set(client,(async()=>{
    await client.batch([
      `CREATE TABLE IF NOT EXISTS workbench_bibles (
        project_id TEXT NOT NULL, version INTEGER NOT NULL, owner TEXT NOT NULL,
        body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,version))`,
      `CREATE TABLE IF NOT EXISTS workbench_shots (
        owner TEXT NOT NULL, draft_id TEXT NOT NULL, node_id TEXT NOT NULL,
        project_id TEXT NOT NULL, shot_id TEXT NOT NULL,
        PRIMARY KEY(owner,draft_id,node_id))`,
    ], 'write');
  })().catch(error=>{initialized.delete(client);throw error;}));
  await initialized.get(client);
}

export function mappedId(prefix: string, ...parts: string[]) {
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
}

export async function readDraft(owner: string, id: string): Promise<{project: Project; revision:number}|null> {
  await workbenchReady();
  const row = (await db().execute({sql:'SELECT body,revision FROM workbench_projects WHERE owner=? AND project_id=?',args:[owner,id]})).rows[0];
  if(!row)return null;
  // Mapping can finish after the last draft save. Rebuild identities on every
  // load so a reload after provider submission still recovers that node's job.
  const mappings=(await db().execute({sql:'SELECT m.node_id,m.shot_id FROM workbench_shots m JOIN shots s ON s.id=m.shot_id WHERE m.owner=? AND m.draft_id=?',args:[owner,id]})).rows;
  return {project:{...JSON.parse(String(row.body)),shotMappings:Object.fromEntries(mappings.map(r=>[String(r.node_id),String(r.shot_id)]))},revision:Number(row.revision)};
}

const writes = new Map<string, Promise<unknown>>();
/** Local clients share a connection; database write transactions protect other instances. */
export async function workbenchTransaction<T>(fn:(tx:Transaction)=>Promise<T>):Promise<T> {
  const tenant=requireTenant().id;
  const prior=writes.get(tenant)??Promise.resolve();
  const result=prior.catch(()=>{}).then(async()=>{
    const tx=await db().transaction('write');
    try {const value=await fn(tx);await tx.commit();return value;}
    catch(error){await tx.rollback().catch(()=>{});throw error;}
    finally{tx.close();}
  });
  writes.set(tenant,result);
  try{return await result;}finally{if(writes.get(tenant)===result)writes.delete(tenant);}
}

/** Validate under the same write lock as saving; a concurrent deletion cannot
 * leave a newly saved snapshot pointing at a source it just removed. */
export async function validateStoredMedia(tx:Transaction,value:unknown) {
  const refs=referencedMedia(value);
  for(const [kind,ids] of [['upload',refs.uploads],['generation',refs.generations]] as const){
    const all=[...ids];
    for(let start=0;start<all.length;start+=500){
      const batch=all.slice(start,start+500);
      const table=kind==='upload'?'uploads':'generations';
      const rows=(await tx.execute({sql:`SELECT id FROM ${table} WHERE id IN (${batch.map(()=>'?').join(',')})${kind==='generation'?' AND deleted=0':''}`,args:batch})).rows;
      const found=new Set(rows.map(row=>String(row.id)));
      const missing=batch.find(id=>!found.has(id));
      if(missing)throw new Error(`A referenced ${kind} is no longer available (${missing}). Remove or replace it before saving or publishing. Your saved work has not changed.`);
    }
  }
}

/** Create the real production records once, under the same plan ceiling/default cap as /api/projects. */
export async function linkProduction(owner: string, project: Project): Promise<string> {
  await workbenchReady();
  if (project.productionProjectId) {
    const found=(await db().execute({sql:'SELECT id FROM projects WHERE id=?',args:[project.productionProjectId]})).rows[0];
    if(!found) throw new Error('The linked project no longer exists in this workspace.');
    return project.productionProjectId;
  }
  const ws=requireTenant();
  const pid=mappedId('prj_wb_',ws.id,owner,project.id);
  const prod=mappedId('prod_wb_',ws.id,owner,project.id);
  const plan=await planOf(ws);
  const ceiling=ceilingFor(plan,'productions');
  const defaultCap=creditsApply(ws)?(await getPlatformLayer()).caps.defaultCapCredits:null;
  return workbenchTransaction(async(tx)=>{
    const exists=(await tx.execute({sql:'SELECT id FROM projects WHERE id=?',args:[pid]})).rows.length;
    if(!exists) {
      const count=Number((await tx.execute('SELECT COUNT(*) AS n FROM projects')).rows[0].n);
      if(ceiling!=null && count>=ceiling) throw new Error(ceilingMessage(plan!,'productions',ceiling));
      await tx.execute({sql:'INSERT INTO productions (id,name,created_at) VALUES (?,?,?)',args:[prod,project.name,now()]});
      await tx.execute({sql:'INSERT INTO projects (id,name,description,created_at,cap_credits,production_id,format) VALUES (?,?,?,?,?,?,?)',args:[pid,project.name,project.description,now(),defaultCap??null,prod,project.aspect]});
    }
    invalidate(PROJECTS_KEY); return pid;
  });
}

/** An explicit stable node→shot identity, independent of editable labels and collaborator drafts. */
export async function mapNodeShot(owner:string, project:Project, nodeId:string):Promise<string> {
  const node=project.nodes.find(n=>n.id===nodeId);
  if(!node || !project.productionProjectId) throw new Error('Save this node in a project first.');
  const pid=await linkProduction(owner,project);
  const sid=mappedId('shot_wb_',owner,project.id,nodeId);
  return workbenchTransaction(async(tx)=>{
    const prior=(await tx.execute({sql:'SELECT m.shot_id FROM workbench_shots m JOIN shots s ON s.id=m.shot_id WHERE m.owner=? AND m.draft_id=? AND m.node_id=?',args:[owner,project.id,nodeId]})).rows[0];
    if(!prior) {
      const position=Number((await tx.execute({sql:'SELECT COALESCE(MAX(position),-1)+1 AS n FROM shots WHERE project_id=?',args:[pid]})).rows[0].n);
      await tx.execute({sql:`INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty) VALUES (?,?,?,?,?,?,'open',?,?,?,?,5,'{}','[]','render',1)`,args:[sid,pid,node.title.slice(0,40),'WB'+sid.slice(-8).toUpperCase(),node.title.slice(0,160),(node.text||'').slice(0,2000),position,owner,now(),now()]});
      await tx.execute({sql:'INSERT INTO workbench_shots(owner,draft_id,node_id,project_id,shot_id) VALUES (?,?,?,?,?) ON CONFLICT(owner,draft_id,node_id) DO UPDATE SET shot_id=excluded.shot_id,project_id=excluded.project_id',args:[owner,project.id,nodeId,pid,sid]});
    }
    return prior?String(prior.shot_id):sid;
  });
}

/** Revision zero may only insert; stale windows may never overwrite a newer draft. */
export async function saveDraft(owner:string, project:Project, revision:number) {
  await workbenchReady();
  const current=await readDraft(owner,project.id);
  if((current?.revision??0)!==revision)throw new Error('This project changed in another window. Download your work before reloading.');
  if(current?.project.productionProjectId && project.productionProjectId && current.project.productionProjectId!==project.productionProjectId)
    throw new Error('A draft cannot change its project. Open a separate space.');
  const pid=await linkProduction(owner,{...project,productionProjectId:current?.project.productionProjectId||project.productionProjectId});
  return workbenchTransaction(async(tx)=>{
    await validateStoredMedia(tx,project);
    const mappings=Object.fromEntries((await tx.execute({sql:'SELECT node_id,shot_id FROM workbench_shots WHERE owner=? AND draft_id=?',args:[owner,project.id]})).rows.map(r=>[String(r.node_id),String(r.shot_id)]));
    const body={...project,productionProjectId:pid,shotMappings:mappings};
    const result=await tx.execute({sql:`INSERT INTO workbench_projects (key,owner,project_id,name,body,revision,updated_at) VALUES (?,?,?,?,?,1,?)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name,body=excluded.body,revision=workbench_projects.revision+1,updated_at=excluded.updated_at WHERE workbench_projects.revision=?`,
      args:[owner+':'+project.id,owner,project.id,project.name,JSON.stringify(body),now(),revision]});
    if(!result.rowsAffected)throw new Error('A newer version exists. Your changes have not overwritten it.');
    return {revision:revision+1,productionProjectId:pid,shotMappings:mappings};
  });
}

export class BibleConflictError extends Error {
  readonly code='bible_conflict';
  constructor(public readonly currentVersion:number){super('Another collaborator published newer shared context. Save your private work and load the latest context before publishing again.');this.name='BibleConflictError';}
}

/** Immutable shared versions require the author's explicit current base. */
export async function publishBible(owner:string, name:string, draftId:string, expectedVersion:number) {
  const draft=await readDraft(owner,draftId);
  if(!draft?.project.productionProjectId)throw new Error('Save your project first.');
  const p=draft.project;
  if(!Number.isInteger(expectedVersion)||expectedVersion<0)throw new Error('Load the current shared context before publishing.');
  const snapshot={...publishedContext(p),publishedBy:name};
  return workbenchTransaction(async(tx)=>{
    const latest=Number((await tx.execute({sql:'SELECT COALESCE(MAX(version),0) AS n FROM workbench_bibles WHERE project_id=?',args:[p.productionProjectId!]})).rows[0].n);
    if(latest!==expectedVersion)throw new BibleConflictError(latest);
    await validateStoredMedia(tx,snapshot);
    const version=latest+1;
    await tx.execute({sql:'INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES (?,?,?,?,?)',args:[p.productionProjectId!,version,owner,JSON.stringify(snapshot),now()]});
    return {version,shared:{...snapshot,version}};
  });
}
