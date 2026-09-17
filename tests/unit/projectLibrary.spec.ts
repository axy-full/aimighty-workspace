import {test,expect} from '@playwright/test';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import type {TenantWorkspace} from '../../lib/tenant';

const dir=mkdtempSync(path.join(tmpdir(),'particl-project-library-'));
process.env.PLATFORM_DATABASE_URL=`file:${path.join(dir,'platform.db')}`;
process.env.TURSO_DATABASE_URL=`file:${path.join(dir,'primary.db')}`;
process.env.KEYRING_SECRET??='unit-test-keyring-secret-unit-test-keyring';
function workspace(id:string):TenantWorkspace {
  return {id,name:id,slug:id,legacy:false,dbUrl:`file:${path.join(dir,`${id}.db`)}`,dbToken:null,keys:{},usesPlatformKeys:false,allowanceUsd:null,ownerId:'member',createdAt:0,gatewayKeyId:null,suspendedAt:null,suspendedReason:null,flaggedAt:null,flagNote:null,concurrency:null,rendersPerHour:null,storageQuotaBytes:null,deletedAt:null};
}
function load<T>(file:string,deps:Record<string,unknown>):T {
  const filename=path.resolve(file),require=createRequire(filename),mod={exports:{}};
  const compiled=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',compiled)((id:string)=>Object.hasOwn(deps,id)?deps[id]:require(id),mod,mod.exports);
  return mod.exports as T;
}
async function seed(ws:TenantWorkspace) {
  const {runInTenant}=await import('../../lib/tenant');
  const {db}=await import('../../lib/db');
  const {newProject}=await import('../../lib/workbench/studio');
  const {projectLibraryReady}=await import('../../lib/workbench/project-library');
  await runInTenant(ws,async()=>{
    await projectLibraryReady();
    await db().batch(['p1','p2'].map(id=>({sql:'INSERT INTO projects(id,name,created_at) VALUES(?,?,0)',args:[id,id]})));
    for(const id of ['draft-upload','other-upload','render-input','shared-upload','edit-source','filed-upload','derived-edit','private-collaborator'])
      await db().execute({sql:"INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind) VALUES(?,?,'image/png','png',100,'hash','https://private.invalid/do-not-expose',200,'image')",args:[id,`${id}.png`]});
    for(const [id,pid,params] of [['project-take','p1',{references:[{uploadId:'render-input'},{genId:'reference-take'}]}],['other-take','p2',{}],['reference-take','p2',{}],['draft-take',null,{}]] as const)
      await db().execute({sql:"INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,'fixture',? ,?,'succeeded',200,200,'image')",args:[id,pid,id,JSON.stringify(params)]});
    const asset=(id:string,extra={})=>({id,name:id,kind:'image',category:'Reference',url:`/api/uploads/${id}`,uploadId:id,description:'',prompt:'',status:'Draft',locked:false,version:1,refs:[],...extra});
    for(const [owner,id,pid,assets] of [
      ['member','draft-one','p1',[asset('draft-upload'),asset('derived-edit',{parentId:'draft-upload'}),{...asset('draft-take'),uploadId:undefined,generationId:'draft-take',url:'/api/media/draft-take'}]],
      ['member','draft-two','p2',[asset('other-upload')]],
      ['collaborator','private-draft','p1',[asset('private-collaborator')]],
    ] as const) {
      const project={...newProject(id),id,productionProjectId:pid,assets};
      await db().execute({sql:'INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)',args:[`${owner}:${id}`,owner,id,id,JSON.stringify(project)]});
    }
    await db().execute({sql:'INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES(?,1,?,?,0)',args:['p1','collaborator',JSON.stringify({assets:[asset('shared-upload')]})]});
    await db().execute({sql:"INSERT INTO workbench_edit_sources(owner,draft_id,version_id,kind,source_id) VALUES('member','draft-one','v1','upload','edit-source')",args:[]});
  });
}
async function routes(ws:TenantWorkspace) {
  const tenant=await import('../../lib/tenant'),scope=await import('../../lib/workbench/request-scope');
  let user='member',signedIn=true,selected=ws;
  const api=load<typeof import('../../app/api/workbench/library/route')>('app/api/workbench/library/route.ts',{
    '@/lib/auth':{withTenant:(handler:(req:Request)=>Promise<Response>)=>(req:Request)=>tenant.runInTenant(selected,()=>handler(req)),requireSession:async()=>signedIn?{user:{id:user}}:{response:Response.json({error:'Sign in'},{status:401})}},
    '@/lib/tenant':tenant,'@/lib/workbench/request-scope':scope,'@/lib/assetPagination':await import('../../lib/assetPagination'),'@/lib/workbench/project-library':await import('../../lib/workbench/project-library'),
  });
  const get=(params='projectId=draft-one&source=uploads',headers:Record<string,string>={'X-Workbench-Scope':scope.workbenchScopeFor(selected.id,user)})=>api.GET(new Request(`https://studio.test/api/workbench/library?${params}`,{headers}),undefined);
  const post=(body:unknown,headers:Record<string,string>={},remove=false)=>api[remove?'DELETE':'POST'](new Request('https://studio.test/api/workbench/library',{method:remove?'DELETE':'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':scope.workbenchScopeFor(selected.id,user),...headers},body:JSON.stringify(body)}),undefined);
  return {get,post,unfile:(body:unknown,headers:Record<string,string>={})=>post(body,headers,true),user:(id:string)=>{user=id;},signedIn:(value:boolean)=>{signedIn=value;},workspace:(value:TenantWorkspace)=>{selected=value;}};
}

test('project library resolves saved production mapping, references, shared context and retained sources with stable pagination',async()=>{
  const ws=workspace('mapping');await seed(ws);const api=await routes(ws);
  const ids:string[]=[];let cursor:string|null=null;
  do {
    const response=await api.get(`projectId=draft-one&source=uploads&limit=2${cursor?`&cursor=${cursor}`:''}`);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body=await response.json();ids.push(...body.uploads.map((item:{id:string})=>item.id));cursor=body.nextCursor;
    expect(JSON.stringify(body)).not.toContain('private.invalid');
  }while(cursor);
  expect(ids).toEqual(['shared-upload','render-input','edit-source','draft-upload','derived-edit']);
  const rows=await (await api.get()).json();expect(rows.uploads.find((item:{id:string})=>item.id==='derived-edit').librarySource).toBe('generation');
  const takes=await (await api.get('projectId=draft-one&source=generations&limit=2')).json();
  expect(takes.generations.map((item:{id:string})=>item.id)).toEqual(['reference-take','project-take']);
  const last=await(await api.get(`projectId=draft-one&source=generations&limit=2&cursor=${takes.nextPageCursor}`)).json();
  expect(last.generations.map((item:{id:string})=>item.id)).toEqual(['draft-take']);expect(last.nextPageCursor).toBeNull();
  const filtered=await(await api.get('projectId=draft-one&source=uploads&q=render-input')).json();expect(filtered.uploads.map((item:{id:string})=>item.id)).toEqual(['render-input']);
});

test('project filing is free and idempotent, preserves workspace originals, and stays outside unrelated projects',async()=>{
  const ws=workspace('filing');await seed(ws);const api=await routes(ws);
  for(let count=0;count<2;count++)expect((await api.post({projectId:'draft-one',uploadId:'filed-upload'})).status).toBe(200);
  const first=await(await api.get()).json();expect(first.uploads.map((item:{id:string})=>item.id)).toContain('filed-upload');
  const second=await(await api.get('projectId=draft-two&source=uploads')).json();expect(second.uploads.map((item:{id:string})=>item.id)).not.toContain('filed-upload');
  const {runInTenant}=await import('../../lib/tenant'),{db}=await import('../../lib/db'),{listLibraryUploads}=await import('../../lib/uploadLibrary');
  await runInTenant(ws,async()=>{expect((await db().execute('SELECT * FROM project_library_uploads')).rows).toHaveLength(1);expect((await listLibraryUploads(new URLSearchParams())).uploads).toHaveLength(8);});
  expect((await api.post({projectId:'draft-one',uploadId:'does-not-exist'})).status).toBe(404);
  const {mediaBindingProblem}=await import('../../lib/mediaBindings'),{workbenchTransaction}=await import('../../lib/workbench/records');
  await runInTenant(ws,async()=>expect(await workbenchTransaction(tx=>mediaBindingProblem(tx,'upload','filed-upload'))).toContain('Remove its project filing'));
  expect(first.uploads.find((item:{id:string})=>item.id==='filed-upload').projectFiled).toBe(true);
  expect((await api.unfile({projectId:'draft-one',uploadId:'filed-upload'})).status).toBe(200);
  expect((await(await api.get()).json()).uploads.map((item:{id:string})=>item.id)).not.toContain('filed-upload');
  await runInTenant(ws,async()=>{
    expect(await workbenchTransaction(tx=>mediaBindingProblem(tx,'upload','filed-upload'))).toBeNull();
    expect((await listLibraryUploads(new URLSearchParams())).uploads.map(upload=>upload.id)).toContain('filed-upload');
    expect(await workbenchTransaction(tx=>mediaBindingProblem(tx,'upload','draft-upload'))).toContain('project draft');
  });
});

test('project library rejects another owner, tenant, stale browser scope and cross-origin writes without widening to all assets',async()=>{
  const ws=workspace('privacy'),other=workspace('privacy-other');await seed(ws);await seed(other);const api=await routes(ws);
  expect((await api.get('projectId=private-draft&source=uploads')).status).toBe(404);
  expect((await api.get('projectId=p1&source=uploads')).status).toBe(404);
  api.user('collaborator');expect((await api.get()).status).toBe(404);expect((await api.post({projectId:'draft-one',uploadId:'draft-upload'})).status).toBe(404);
  expect((await api.unfile({projectId:'draft-one',uploadId:'draft-upload'})).status).toBe(404);
  api.user('member');expect((await api.get(undefined,{})).status).toBe(409);
  api.workspace(other);expect((await api.get(undefined,{'X-Workbench-Scope':`particl-active-${ws.id}-member`})).status).toBe(409);
  expect((await api.post({projectId:'draft-one',uploadId:'draft-upload'},{Origin:'https://evil.invalid'})).status).toBe(403);
  expect((await api.unfile({projectId:'draft-one',uploadId:'draft-upload'},{Origin:'https://evil.invalid'})).status).toBe(403);
  api.signedIn(false);expect((await api.get()).status).toBe(401);expect((await api.post({projectId:'draft-one',uploadId:'draft-upload'})).status).toBe(401);
});

test('project library validates bounded paging and requires explicit project and source',async()=>{
  const ws=workspace('validation');await seed(ws);const api=await routes(ws);
  for(const params of ['source=uploads','projectId=draft-one','projectId=draft-one&source=all','projectId=draft-one&projectId=draft-two&source=uploads','projectId=draft-one&source=uploads&source=generations','projectId=draft-one&source=uploads&limit=999','projectId=draft-one&source=uploads&cursor=bad'])
    expect((await api.get(params)).status,params).toBe(400);
  expect((await api.post({projectId:'draft-one',uploadId:'draft-upload',productionProjectId:'p2'})).status).toBe(400);
});
