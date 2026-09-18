import {test,expect,type Page,type Locator} from '@playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createClient} from '@libsql/client';
import {signInLocally,localPlatformDbUrl} from './helpers/workbenchLocal';
import {newProject,type Asset} from '../lib/workbench/studio';

async function fixture(page:Page) {
  const account=await signInLocally(page.request);
  const planDb=createClient({url:localPlatformDbUrl()});
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
  const platform=createClient({url:localPlatformDbUrl()});
  let dbUrl:string;
  try{dbUrl=String((await platform.execute({sql:'SELECT db_url FROM workspaces WHERE id=?',args:[account.workspace.id]})).rows[0].db_url);}finally{platform.close();}
  expect(dbUrl).toMatch(/^file:/);const tenant=createClient({url:dbUrl});
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

async function openGenLibrary(page:Page,projectId:string) {
  await page.goto(`/generate?project=${projectId}&mode=images`);
  if(page.viewportSize()!.width<900)
    await page.getByRole('group',{name:'Generation view',exact:true}).getByRole('button',{name:'Takes & assets',exact:true}).click();
  return page.getByRole('region',{name:'Workspace asset library',exact:true});
}
async function addCardToProject(page:Page,card:Locator) {
  if(page.viewportSize()!.width<=759){
    await card.getByRole('button',{name:/^Actions for /}).click();
    await page.getByRole('menuitem',{name:'Add to project',exact:true}).click();
  } else await card.getByRole('button',{name:'Add to project',exact:true}).click();
}

test('Gen browses workspace originals by default, preserves project isolation, and files explicit additions and uploads to the selected project',async({page},info)=>{
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded project-library coverage');
  const f=await fixture(page),library=await openGenLibrary(page,f.project.id);
  const scope=library.getByRole('group',{name:'Asset scope',exact:true});
  const source=library.getByRole('group',{name:'Asset source',exact:true});
  const all=scope.getByRole('button',{name:'All workspace assets',exact:true});
  const project=scope.getByRole('button',{name:'This project',exact:true});
  const card=(origin:'generation'|'upload',id:string)=>library.locator(`[data-library-id="${origin}:${id}"]`);
  await expect(all).toHaveAttribute('aria-pressed','true');
  await expect(source.getByRole('button',{name:'Uploads',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(card('upload',f.original.id)).toBeVisible();
  await expect(card('upload',f.other.id)).toBeVisible();
  await expect(card('generation',f.generation)).toHaveCount(0);
  await source.getByRole('button',{name:'Generations',exact:true}).click();
  await expect(card('generation',f.generation)).toBeVisible();
  await expect(card('generation',f.otherGeneration)).toBeVisible();
  await expect(card('upload',f.other.id)).toHaveCount(0);
  await project.click();
  await expect(card('generation',f.generation)).toBeVisible();
  await expect(card('generation',f.otherGeneration)).toHaveCount(0);
  await source.getByRole('button',{name:'Uploads',exact:true}).click();
  await expect(card('upload',f.original.id)).toBeVisible();
  await expect(card('upload',f.other.id)).toHaveCount(0);

  const search=library.getByRole('textbox',{name:'Search assets',exact:true});
  await search.fill('Other project original');
  await expect(library.locator('[data-library-id]')).toHaveCount(0);
  await all.click();
  await expect(card('upload',f.other.id)).toBeVisible();
  await expect(card('upload',f.original.id)).toHaveCount(0);
  await search.fill('');
  await expect(card('upload',f.original.id)).toBeVisible();
  await expect(card('upload',f.other.id)).toBeVisible();
  await addCardToProject(page,card('upload',f.other.id));
  await expect.poll(async()=>{
    const response=await page.request.get(`/api/workbench/projects?id=${f.project.id}`,{headers:f.headers});
    return (await response.json()).project.assets.some((asset:Asset)=>asset.uploadId===f.other.id);
  }).toBe(true);
  await project.click();
  await expect(card('upload',f.other.id)).toBeVisible();

  await all.click();
  const finish=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/uploads/finish'&&response.request().method()==='POST');
  await library.getByLabel('Upload library assets',{exact:true}).setInputFiles({name:'Workspace-browse project source.png',mimeType:'image/png',buffer:f.bytes});
  const stored=await(await finish).json();
  await expect(card('upload',stored.id)).toBeVisible();
  await expect.poll(async()=>{
    const response=await page.request.get(`/api/workbench/library?projectId=${f.project.id}&source=uploads`,{headers:f.headers});
    return (await response.json()).uploads.some((upload:{id:string;projectFiled?:boolean})=>upload.id===stored.id&&upload.projectFiled===true);
  }).toBe(true);
  const unrelated=await page.request.get(`/api/workbench/library?projectId=${f.second.id}&source=uploads`,{headers:f.headers}).then(response=>response.json());
  expect(unrelated.uploads.some((upload:{id:string})=>upload.id===stored.id)).toBe(false);
  await project.click();
  await expect(card('upload',stored.id)).toBeVisible();
  expect(await page.request.get(stored.url).then(response=>response.body())).toEqual(f.bytes);
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed','true');
  await expect(source.getByRole('button',{name:'Uploads',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(search).toHaveValue('');
  await expect(card('upload',f.other.id)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('gen-workspace-browse.png'),animations:'disabled'});
});

test('Gen distinguishes loading and failed lists from empty results and ignores a late response after a scope switch',async({page},info)=>{
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded project-library coverage');
  const f=await fixture(page);
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  let requests=0,fail=true;
  const workspaceUploads=(url:URL)=>url.pathname==='/api/uploads';
  await page.route(workspaceUploads,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    requests++;await held;
    if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture library unavailable'})});
    return route.fallback();
  });
  try {
    const library=await openGenLibrary(page,f.project.id);
    await expect.poll(()=>requests).toBeGreaterThan(0);
    await expect(library.getByRole('status')).toHaveText('Loading uploads from this workspace…');
    await expect(library.getByText(/^0 loaded$/)).toHaveCount(0);
    await expect(library.getByRole('heading',{name:'Images',exact:true})).toHaveCount(0);
    release();
    await expect(library.getByRole('alert')).toContainText('Fixture library unavailable');
    await expect(library.getByText(/^0 loaded$/)).toHaveCount(0);
    fail=false;
    await library.getByRole('button',{name:'Retry library',exact:true}).click();
    await expect(library.locator(`[data-library-id="upload:${f.other.id}"]`)).toBeVisible();
    await page.unroute(workspaceUploads);

    let releaseLate!:()=>void;
    const late=new Promise<void>(resolve=>{releaseLate=resolve;});
    let lateRequested=false,lateFinished=false;
    await page.route(url=>url.pathname==='/api/uploads'&&url.searchParams.get('q')==='Other project original',async route=>{
      lateRequested=true;const response=await route.fetch();await late;
      await route.fulfill({response});lateFinished=true;
    });
    try {
      await library.getByRole('textbox',{name:'Search assets',exact:true}).fill('Other project original');
      await expect.poll(()=>lateRequested).toBe(true);
      await library.getByRole('group',{name:'Asset scope',exact:true}).getByRole('button',{name:'This project',exact:true}).click();
      await expect(library.getByRole('heading',{name:'Images',exact:true})).toBeVisible();
      await expect(library.locator('[data-library-id]')).toHaveCount(0);
      releaseLate();await expect.poll(()=>lateFinished).toBe(true);
      await expect(library.locator(`[data-library-id="upload:${f.other.id}"]`)).toHaveCount(0);
      await library.getByRole('textbox',{name:'Search assets',exact:true}).fill('');
      await expect(library.locator(`[data-library-id="upload:${f.original.id}"]`)).toBeVisible();
      await expect(library.locator(`[data-library-id="upload:${f.other.id}"]`)).toHaveCount(0);
    } finally {releaseLate();}
  } finally {release();}
});

test('project library separates sources, retains original downloads and private files, paginates renders and imports from All assets',async({page},info)=>{
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded project-library coverage');
  const f=await fixture(page),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/library?project=${f.project.id}`);
  const library=page.getByRole('region',{name:'Project asset library',exact:true});
  const source=library.getByRole('group',{name:'Asset source',exact:true});
  await expect(library.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  await expect(source.getByRole('button',{name:'Uploads',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(library.locator(`[data-library-id="upload:${f.original.id}"]`)).toBeVisible();
  await expect(library.locator(`[data-library-id="upload:${f.other.id}"]`)).toHaveCount(0);
  await expect(library.locator(`[data-library-id="generation:${f.generation}"]`)).toHaveCount(0);
  await expect(library.getByRole('heading',{level:3}).filter({hasText:/^(Images|Videos|Audio|Documents|Other files)$/})).toHaveText(['Images','Videos','Audio','Documents','Other files']);
  const privateOriginal=library.getByRole('link',{name:'Download Historical camera original',exact:true});
  await expect(privateOriginal).toHaveAttribute('href',`/api/workbench/media/${f.privateId}?download=1`);
  const downloaded=await page.request.get((await privateOriginal.getAttribute('href'))!);
  expect(downloaded.ok()).toBe(true);expect(await downloaded.body()).toEqual(f.bytes);expect(downloaded.headers()['content-disposition']).toContain('attachment');
  const finished=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/uploads/finish'&&response.request().method()==='POST');
  await library.getByLabel('Upload library assets',{exact:true}).setInputFiles({name:'New project source.png',mimeType:'image/png',buffer:f.bytes});
  const stored=await(await finished).json();
  await expect(library.locator(`[data-library-id="upload:${stored.id}"]`)).toBeVisible();
  const otherList=await page.request.get(`/api/workbench/library?projectId=${f.second.id}&source=uploads`,{headers:f.headers}).then(response=>response.json());
  expect(otherList.uploads.map((upload:{id:string})=>upload.id)).not.toContain(stored.id);
  const storedCard=library.locator(`[data-library-id="upload:${stored.id}"]`);
  await storedCard.getByRole('button',{name:'Actions for New project source.png',exact:true}).click();
  await page.getByRole('menuitem',{name:'Remove project filing',exact:true}).click();
  await expect(storedCard).toHaveCount(0);
  expect(await page.request.get(stored.url).then(response=>response.body())).toEqual(f.bytes);
  await source.getByRole('button',{name:'Generations',exact:true}).click();
  await expect(library.locator(`[data-library-id="generation:${f.generation}"]`)).toBeVisible();
  await expect(library.locator('[data-library-id^="generation:"]')).toHaveCount(60);
  await library.getByRole('button',{name:'Load more takes',exact:true}).click();
  await expect(library.locator('[data-library-id^="generation:"]')).toHaveCount(62);
  const takeOriginal=await page.request.get(`/api/media/${f.generation}?download=1`);expect(takeOriginal.ok()).toBe(true);expect(await takeOriginal.body()).toEqual(f.bytes);
  await page.getByRole('textbox',{name:'Search project assets',exact:true}).fill('Project hero');
  await expect(library.locator('[data-library-id]')).toHaveCount(1);
  await source.evaluate(element=>{let parent=element.parentElement;while(parent){if(getComputedStyle(parent).overflowY==='auto')parent.scrollTop=0;parent=parent.parentElement;}});
  await page.screenshot({path:info.outputPath('project-generations.png'),animations:'disabled'});
  await page.goto(`/library?all=1&project=${f.project.id}`);
  const all=page.getByRole('region',{name:'Collective workspace assets',exact:true});
  const imported=all.locator(`[data-library-id="upload:${f.other.id}"]`);
  await expect(imported).toBeVisible();
  if(page.viewportSize()!.width<=759){await imported.getByRole('button',{name:/^Actions for /}).click();await page.getByRole('menuitem',{name:'Add to project',exact:true}).click();}
  else await imported.getByRole('button',{name:'Add to project',exact:true}).click();
  await expect(page.getByText('Asset added to the project.',{exact:true})).toBeVisible();
  await page.goto(`/library?project=${f.project.id}`);
  await expect(page.locator(`[data-library-id="upload:${f.other.id}"]`)).toBeVisible();
  await page.goto(`/library?project=${f.second.id}`);
  await expect(page.locator(`[data-library-id="upload:${f.other.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-library-id="upload:${f.original.id}"]`)).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath('project-uploads.png'),animations:'disabled'});
  await page.evaluate(scope=>localStorage.removeItem(scope),f.scope);
  await page.goto('/library');
  await expect(page.getByRole('heading',{name:'Choose a project',exact:true})).toBeVisible();
  await expect(page.locator('[data-library-id]')).toHaveCount(0);
});
