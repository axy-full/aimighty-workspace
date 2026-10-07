import {test,expect,type Page} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@libsql/client';
import {signInLocally,localPlatformDbUrl} from './helpers/workbenchLocal';
import {newProject,type Asset} from '../lib/workbench/studio';

async function fixture(page:Page) {
  const account=await signInLocally(page.request);
  const planDb=createClient({url:localPlatformDbUrl(),timeout:10_000});
  try{await planDb.execute({sql:"UPDATE workspaces SET plan_id='studio' WHERE id=?",args:[account.workspace.id]});}finally{planDb.close();}
  const me=await page.request.get('/api/me').then(response=>response.json());
  const scope=`particl-active-${account.workspace.id}-${me.id}`,headers={'X-Workbench-Scope':scope};
  const bytes=await readFile('public/fixtures/still.png');
  const upload=async(name:string)=>{
    const session=randomUUID();
    const chunk=await page.request.post('/api/uploads/chunk',{headers,multipart:{session,index:'0',chunk:{name:'chunk',mimeType:'application/octet-stream',buffer:bytes}}});
    expect(chunk.ok(),await chunk.text()).toBe(true);
    const response=await page.request.post('/api/uploads/finish',{headers,data:{session,count:1,filename:name,purpose:'chat'}});
    expect(response.ok(),await response.text()).toBe(true);return response.json();
  };
  const original=await upload('Project lighting original.png'),other=await upload('Other project original.png');
  const privateId=`private_${randomUUID().replaceAll('-','')}`;
  const asset=(id:string,name:string):Asset=>({id,name,kind:'image',category:'Reference',url:`/api/uploads/${id}`,uploadId:id,description:'',prompt:'',status:'Draft',locked:false,version:1,refs:[]});
  const project={...newProject('Feature project'),assets:[asset(original.id,original.filename),{...asset(privateId,'Historical camera original'),uploadId:undefined,url:`/api/workbench/media/${privateId}`}]};
  const second={...newProject('Other project'),assets:[asset(other.id,other.filename)]};
  const save=async(value:typeof project)=>{
    const response=await page.request.put('/api/workbench/projects',{headers,data:{project:value,revision:0}});
    expect(response.ok(),await response.text()).toBe(true);return response.json();
  };
  const saved=await save(project),secondSaved=await save(second);
  const platform=createClient({url:localPlatformDbUrl(),timeout:10_000});
  let dbUrl:string;
  try{dbUrl=String((await platform.execute({sql:'SELECT db_url FROM workspaces WHERE id=?',args:[account.workspace.id]})).rows[0].db_url);}finally{platform.close();}
  expect(dbUrl).toMatch(/^file:/);const tenant=createClient({url:dbUrl,timeout:10_000});
  const generation=`render_${randomUUID().replaceAll('-','')}`,otherGeneration=`render_${randomUUID().replaceAll('-','')}`;
  try {
    await mkdir('.data/generations',{recursive:true});await mkdir('.data/uploads',{recursive:true});
    await writeFile(`.data/generations/${generation}.png`,bytes);await writeFile(`.data/generations/${otherGeneration}.png`,bytes);await writeFile(`.data/uploads/${privateId}.png`,bytes);
    await tenant.execute({sql:"INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES(?,?,?,'image/png','png',?,'',?)",args:[privateId,me.id,'Historical camera original.png',bytes.length,createHash('sha256').update(bytes).digest('hex')]});
    await tenant.execute({sql:"INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,'gemini-3-pro-image','Cinematic frame','{}','succeeded',?,'image','Project hero take',?,200,200)",args:[generation,saved.productionProjectId,`/api/media/${generation}`,me.id]});
    await tenant.execute({sql:"INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,'gemini-3-pro-image','Other project frame','{}','succeeded',?,'image','Other project take',?,300,300)",args:[otherGeneration,secondSaved.productionProjectId,`/api/media/${otherGeneration}`,me.id]});
    await tenant.batch(Array.from({length:61},(_,index)=>({sql:"INSERT INTO generations(id,project_id,model,prompt,params,status,kind,title,created_by,created_at,updated_at) VALUES(?,?,'fixture','Historical render','{}','failed','image',?,?,100,100)",args:[`${generation}_${String(index).padStart(3,'0')}`,saved.productionProjectId,`Historical render ${index}`,me.id]})));
  }finally{tenant.close();}
  await page.route(/\/api\/(generate|audio|soul\/identities)$/,route=>{if(route.request().method()==='POST')throw new Error('Library tests must not submit provider work.');return route.fallback();});
  return{project,second,original,other,generation,otherGeneration,privateId,scope,headers,bytes};
}

test('a project library lookup by id answers a render past the loaded pages and nothing from another project or scope',async({page},info)=>{
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded project-library coverage');
  const f=await fixture(page);
  const get=(query:string,headers:Record<string,string>=f.headers)=>page.request.get(`/api/workbench/library?projectId=${f.project.id}&${query}`,{headers});
  const first=await(await get('source=generations')).json();
  const loaded=new Set(first.generations.map((item:{id:string})=>item.id));
  expect(first.nextPageCursor).toBeTruthy();
  const older=Array.from({length:61},(_,index)=>`${f.generation}_${String(index).padStart(3,'0')}`).find(id=>!loaded.has(id))!;
  expect(older,'a render the first page does not hold').toBeTruthy();
  const found=await(await get(`source=generations&id=${older}`)).json();
  expect(found.generations.map((item:{id:string})=>item.id)).toEqual([older]);
  expect(found.nextPageCursor).toBeNull();
  /* The other project's render and upload are not this project's, whoever asks. */
  expect((await(await get(`source=generations&id=${f.otherGeneration}`)).json()).generations).toEqual([]);
  expect((await(await get(`source=uploads&id=${f.other.id}`)).json()).uploads).toEqual([]);
  expect((await(await get(`source=uploads&id=${f.original.id}`)).json()).uploads.map((item:{id:string})=>item.id)).toEqual([f.original.id]);
  expect((await get(`source=generations&id=${older}`,{'X-Workbench-Scope':'particl-active-another-workspace-someone'})).status()).toBe(409);
  expect((await get('source=generations&id=..%2Fx')).status()).toBe(400);
  expect((await get(`source=generations&id=${older}&cursor=${first.nextPageCursor}`)).status()).toBe(400);
});
