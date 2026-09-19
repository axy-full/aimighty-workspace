import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import sharp from 'sharp';
import { signInLocally, localPlatformDbUrl } from './helpers/workbenchLocal';
import { goWorkbenchStage } from './helpers/workbenchNavigation';
import { newProject, type Project } from '../lib/workbench/studio';
import { paidActionStorageKey } from '../lib/usePaidAction';
import type { SoulIdentity } from '../lib/workbench/soul-identity';

async function fixture(page: Page, options: {realSoul?:boolean} = {}) {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { 'X-Workbench-Scope': scope };
  const image = await readFile('public/campaign/character.webp');
  const response = await page.request.post('/api/uploads', { headers, multipart: { file: { name:'Mira original.webp',mimeType:'image/webp',buffer:image } } });
  expect(response.ok(), await response.text()).toBe(true);
  const uploaded = await response.json();
  const platform = createClient({ url:localPlatformDbUrl() });
  if(options.realSoul) await platform.execute({sql:'INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,?,?,?,?)',args:[`soul-fixture-${randomUUID()}`,me.workspace.id,1000,'Isolated mock Soul UI fixture','manual',Date.now()]});
  const row = await platform.execute({ sql:'SELECT db_url FROM workspaces WHERE id=?',args:[me.workspace.id] });
  platform.close();
  const tenantUrl = String(row.rows[0].db_url);
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url:tenantUrl });
  const generationId = `gen_soul_fixture_${randomUUID()}`;
  await tenant.execute({ sql:"INSERT INTO generations(id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[generationId,'gemini-3-pro-image','Mira generated portrait','{}','succeeded',`/api/media/${generationId}`,'image','Mira generated still',me.id,Date.now(),Date.now()] });
  tenant.close();
  await page.route(`**/api/media/${generationId}*`, route => route.fulfill({ contentType:'image/webp',body:image }));
  const project = newProject('Soul identity studio fixture');
  project.assets = [
    {id:'original',name:'Mira original',kind:'image',category:'Character',url:uploaded.url,uploadId:uploaded.id,description:'Original portrait',prompt:'',status:'Draft',locked:false,version:1,refs:[]},
    {id:'generated',name:'Mira generated still',kind:'image',category:'Reference',url:`/api/media/${generationId}`,generationId,description:'Generated portrait',prompt:'',status:'Draft',locked:false,version:1,refs:[]},
  ];
  const saved = await page.request.put('/api/workbench/projects', { headers,data:{project,revision:0} });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({scope,id}) => localStorage.setItem(scope,id), {scope,id:project.id});
  async function current() { return (await page.request.get(`/api/workbench/projects?id=${project.id}`, {headers}).then(response => response.json())).project as Project; }
  let configured = true, loseFirst = true, requests = 0;
  const identities: SoulIdentity[] = [];
  const submissions: {body:string;key:string|undefined;scope:string|undefined}[] = [];
  if(!options.realSoul) await page.route('**/api/soul/identities*', async route => {
    const request = route.request();
    expect(request.headers()['x-workbench-scope']).toBe(scope);
    if (request.method() === 'GET') return route.fulfill({json:{identities,configured,generationAvailable:false,terms:{minPhotos:1,maxPhotos:40,trainingCredits:250}}});
    requests++;
    submissions.push({body:request.postData()!,key:request.headers()['idempotency-key'],scope:request.headers()['x-workbench-scope']});
    const input = request.postDataJSON();
    expect(input.projectId).toBe(project.id);
    expect(input.maxCredits).toBe(250);
    expect(input.consent).toBe(true);
    expect((await current()).productionProjectId).toBeTruthy();
    if (!identities.length) identities.push({id:'soul-local-browser',projectId:project.id,name:input.name,description:input.description,subjectType:input.subjectType,references:input.references,status:'training',previewUrl:uploaded.url,createdAt:1,updatedAt:1,creditsBilled:250,error:null});
    if (loseFirst) { loseFirst=false; return route.fulfill({status:503,json:{error:'The training response was lost.'}}); }
    return route.fulfill({status:202,headers:{'Idempotency-Status':'complete'},json:{identity:identities[0]}});
  });
  await page.route(/\/api\/(generate|audio)$/, () => { throw new Error('This UI test must never submit a generation.'); });
  return {scope,project,current,identities,submissions,uploaded,generationId,image,requests:()=>requests,setConfigured:(value:boolean)=>{configured=value;}};
}

test('Soul ID training recovers the exact paid request and binds ready portraits across Cast & Elements', async ({page}, info) => {
  test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded phone and desktop coverage');
  const f = await fixture(page);
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/workbench');
  await goWorkbenchStage(page,'characters');
  await page.getByRole('button',{name:'Identity',exact:true}).click();
  let panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await expect(panel.getByText('No identities yet.',{exact:false})).toBeVisible();
  await expect(panel).toContainText('Props, products and worlds stay as ordinary image references.');
  await panel.getByRole('textbox',{name:'Identity name',exact:true}).fill('Mira trained likeness');
  await panel.getByRole('textbox',{name:'Identity continuity notes',exact:true}).fill('Consistent short dark bob and natural expression.');
  await panel.getByRole('checkbox',{name:'Use portrait Mira original',exact:true}).check();
  await panel.getByRole('checkbox',{name:'Use portrait Mira generated still',exact:true}).check();
  const finished=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/uploads/finish'&&response.request().method()==='POST');
  await panel.getByLabel('Upload identity portraits',{exact:true}).setInputFiles({name:'Mira alternate.webp',mimeType:'image/webp',buffer:await sharp(f.image).modulate({brightness:0.95}).webp().toBuffer()});
  const alternate=await (await finished).json();
  await expect(panel.getByRole('checkbox',{name:'Use portrait Mira alternate.webp',exact:true})).toBeChecked();
  const submit=panel.getByRole('button',{name:'Train identity · 250 credits',exact:true});
  await expect(submit).toBeDisabled();
  await panel.getByRole('checkbox',{name:/I have the rights and consent/}).check();
  await expect(submit).toBeEnabled();
  await panel.evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:info.outputPath('soul-id-create.png')});
  expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await submit.click();
  await expect(panel.getByRole('button',{name:'Recover training request',exact:true})).toBeVisible();
  expect(f.requests()).toBe(1);
  expect(JSON.parse(f.submissions[0].body).references).toEqual([{uploadId:f.uploaded.id},{genId:f.generationId},{uploadId:alternate.id}]);
  await page.reload();
  await goWorkbenchStage(page,'characters');
  await page.getByRole('button',{name:'Identity',exact:true}).click();
  panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await expect(panel.getByText('Mira trained likeness · 3 portraits · 250 credits',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Recover training request',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Recover training request',exact:true})).toHaveCount(0);
  expect(f.requests()).toBe(2);
  expect(f.submissions[1]).toEqual(f.submissions[0]);
  expect(f.submissions[0].key).toBeTruthy();
  f.identities[0].status='ready';
  await panel.getByRole('button',{name:'Refresh identities',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('Ready');
  await panel.evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:info.outputPath('soul-id-ready.png')});
  await panel.getByRole('button',{name:'Use in Characters',exact:true}).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async()=> (await f.current()).assets.find(asset=>asset.soulIdentityId==='soul-local-browser'&&asset.category==='Character')).toMatchObject({url:f.uploaded.url,uploadId:f.uploaded.id,refs:[]});
  await page.reload();
  await goWorkbenchStage(page,'characters');
  await expect(page.getByRole('article',{name:'Asset: Mira trained likeness',exact:true})).toBeVisible();
  await goWorkbenchStage(page,'elements');
  await page.getByRole('button',{name:'Element identity',exact:true}).click();
  panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await panel.getByRole('button',{name:'Use in Elements',exact:true}).click();
  await expect(panel).toHaveCount(0);
  const element=page.getByRole('region',{name:'Elements',exact:true}).getByRole('article',{name:'Asset: Mira trained likeness',exact:true});
  await element.getByRole('button',{name:'To canvas',exact:true}).click();
  await expect.poll(async()=>{const p=await f.current(); const bound=p.assets.find(asset=>asset.soulIdentityId==='soul-local-browser'&&asset.category==='Element'); return p.nodes.some(node=>node.type==='element'&&node.assetId===bound?.id);}).toBe(true);
  const draft=await page.request.get(`/api/workbench/projects?id=${f.project.id}`,{headers:{'X-Workbench-Scope':f.scope}}).then(response=>response.json());
  const boundCharacter=(draft.project as Project).assets.find(asset=>asset.category==='Character'&&asset.soulIdentityId==='soul-local-browser')!;
  draft.project.nodes.push({id:'soul-actor-node',type:'character',title:'Bound Soul actor',assetId:boundCharacter.id,x:40,y:40,width:280,linked:[]}, {id:'soul-generate-node',type:'generate',title:'Soul character shot',text:'A close portrait with soft window light.',x:390,y:40,width:344,linked:['soul-actor-node']});
  const savedGraph=await page.request.put('/api/workbench/projects',{headers:{'X-Workbench-Scope':f.scope},data:{project:draft.project,revision:draft.revision}});
  expect(savedGraph.ok(),await savedGraph.text()).toBe(true);
  await page.route('**/api/workbench/engines*',route=>{
    const query=new URL(route.request().url()).searchParams;
    if(query.has('model')) {
      expect(query.get('soulIdentityId')).toBe('soul-local-browser');
      expect(query.get('projectId')).toBe(f.project.id);
      expect(query.getAll('uploadId')).toEqual([]);expect(query.getAll('genId')).toEqual([]);
      return route.fulfill({json:{credits:3}});
    }
    return route.fulfill({json:{models:[{id:'hf-soul-character',label:'Identity render',kind:'image',resolutions:['1080p'],ratios:['16:9'],durations:[],maxReferenceImages:0,maxReferenceVideos:0,soulIdentity:true}]}});
  });
  const generationBodies:Record<string,unknown>[]=[];
  await page.route(/\/api\/generate$/,route=>{generationBodies.push(route.request().postDataJSON());return route.fulfill({status:202,headers:{'Idempotency-Status':'complete'},json:{id:'gen-soul-test-sink',status:'queued'}});});
  await page.reload();await goWorkbenchStage(page,'canvas');
  if(page.viewportSize()!.width<760){await page.locator('.mobile-node-viewbar').getByRole('tab',{name:'List',exact:true}).click();await page.locator('.mobile-node-list button').filter({hasText:'Soul character shot'}).click();}
  else {const node=page.getByRole('article',{name:'Generate node: Soul character shot',exact:true});await node.focus();await node.press('Enter');}
  await page.getByRole('button',{name:'Generate take',exact:true}).click();
  const generation=page.getByRole('dialog',{name:'Generate a new take',exact:true});
  await expect(generation.getByRole('combobox',{name:'Generation engine',exact:true})).toHaveValue('hf-soul-character');
  await expect(generation.getByRole('combobox',{name:'Identity',exact:true})).toHaveValue('soul-local-browser');
  const strength=generation.getByRole('slider',{name:'Identity likeness strength',exact:true});await strength.focus();await strength.press('Home');for(let n=0;n<13;n++)await strength.press('ArrowRight');
  await expect(strength).toHaveValue('0.65');
  await expect(generation).toHaveCSS('z-index','101');
  await generation.evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>undefined)));});
  await expect(generation).toHaveCSS('opacity','1');
  await expect(page.locator('[data-slot="dialog-overlay"][data-state="open"]').last()).toHaveCSS('z-index','100');
  await page.screenshot({path:info.outputPath('soul-generation.png'),animations:'disabled'});
  await generation.getByRole('button',{name:'Generate · 3 cr estimated',exact:true}).click();
  await expect(generation).toHaveCount(0);
  expect(generationBodies).toHaveLength(1);
  expect(generationBodies[0]).toMatchObject({soulIdentityId:'soul-local-browser',workbenchProjectId:f.project.id,soulStrength:0.65,references:[]});
  expect(generationBodies[0]).not.toHaveProperty('custom_reference_id');
  expect(generationBodies[0]).not.toHaveProperty('providerReferenceId');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(errors).toEqual([]);
});

test('Soul ID submits through the real mock backend and saves a usable local binding',async({page},info)=>{
  test.skip(info.project.name!=='workbench-1440x900','one full local mock integration');
  const f=await fixture(page,{realSoul:true});
  await page.goto('/workbench');await goWorkbenchStage(page,'characters');
  await page.getByRole('button',{name:'Identity',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await expect(panel.getByText('No identities yet.',{exact:false})).toBeVisible();
  await panel.getByRole('textbox',{name:'Identity name',exact:true}).fill('Mock trained actor');
  await panel.getByRole('checkbox',{name:'Use portrait Mira original',exact:true}).check();
  await expect(panel).toContainText('Accepted training requests are billed even if training later fails.');
  await panel.getByRole('checkbox',{name:/I have the rights and consent/}).check();
  const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/soul/identities'&&response.request().method()==='POST');
  await panel.getByRole('button',{name:/^Train identity · /}).click();
  const response=await accepted;expect(response.ok(),await response.text()).toBe(true);
  const body=await response.json();expect(body.identity.id).toBeTruthy();expect(body.identity).not.toHaveProperty('providerReferenceId');
  await expect(panel.getByRole('button',{name:'Use in Characters',exact:true})).toBeVisible({timeout:20000});
  await panel.getByRole('button',{name:'Use in Characters',exact:true}).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async()=> (await f.current()).assets.some(asset=>asset.soulIdentityId===body.identity.id&&asset.uploadId===f.uploaded.id)).toBe(true);
  const state=await page.request.get(`/api/soul/identities?projectId=${f.project.id}`,{headers:{'X-Workbench-Scope':f.scope}}).then(response=>response.json());
  expect(state.identities).toHaveLength(1);expect(state.identities[0].status).toBe('ready');expect(state.identities[0].creditsBilled).toBeGreaterThan(0);
  await page.goto('/settings#engines');
  const connection=page.locator('.management-card').filter({has:page.getByRole('heading',{name:'Connected identity account',exact:true})});
  await expect(connection.getByRole('textbox',{name:'Identity account API key ID',exact:true})).toBeVisible();
  await expect(connection.getByLabel('Identity account API key secret',{exact:true})).toHaveAttribute('type','password');
  await expect(connection.getByRole('button',{name:'Save identity account',exact:true})).toBeDisabled();
  await connection.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('higgsfield-connection.png')});
});

test('Soul IDs still load when recovery storage is malformed, while training fails closed',async({page},info)=>{
  test.skip(info.project.name!=='workbench-1440x900','one storage guard regression');
  const f=await fixture(page);
  f.setConfigured(false);
  f.identities.push({id:'soul-ready',projectId:f.project.id,name:'Saved identity',description:'',subjectType:'character',references:[{uploadId:f.uploaded.id}],status:'ready',previewUrl:f.uploaded.url,createdAt:1,updatedAt:1,creditsBilled:250,error:null});
  await page.addInitScript(key=>localStorage.setItem(key,'broken-record'),paidActionStorageKey(f.scope,'workbench',`soul-identity:${f.project.id}`));
  await page.goto('/workbench');
  await goWorkbenchStage(page,'elements');
  await page.getByRole('button',{name:'Element identity',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await expect(panel).toContainText('The saved request cannot be read.');
  await expect(panel.getByRole('article',{name:'Identity: Saved identity',exact:true})).toBeVisible();
  await expect(panel.getByText('Connect an identity trainer',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'New identity',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Train identity · 250 credits',exact:true})).toBeDisabled();
  expect(f.requests()).toBe(0);
});

test('ordinary generation keeps a regular image engine as default when Soul is also enabled',async({page},info)=>{
  test.skip(info.project.name!=='workbench-1440x900','one default engine regression');
  const f=await fixture(page);
  const headers={'X-Workbench-Scope':f.scope};
  const draft=await page.request.get(`/api/workbench/projects?id=${f.project.id}`,{headers}).then(response=>response.json());
  draft.project.nodes=[{id:'ordinary-image-node',type:'generate',title:'Ordinary image shot',assetId:'original',text:'A close portrait.',x:40,y:40,width:344,linked:[]}];
  const saved=await page.request.put('/api/workbench/projects',{headers,data:{project:draft.project,revision:draft.revision}});
  expect(saved.ok(),await saved.text()).toBe(true);
  await page.route('**/api/workbench/engines*',route=>{
    if(new URL(route.request().url()).searchParams.has('model'))return route.fulfill({json:{credits:3}});
    const base={kind:'image',resolutions:['1080p'],ratios:['16:9'],durations:[],maxReferenceVideos:0};
    return route.fulfill({json:{models:[{...base,id:'hf-soul-character',label:'Identity render',maxReferenceImages:0,soulIdentity:true},{...base,id:'gemini-3-pro-image',label:'Image Pro',maxReferenceImages:8}]}});
  });
  await page.goto('/workbench');await goWorkbenchStage(page,'canvas');
  const node=page.getByRole('article',{name:'Generate node: Ordinary image shot',exact:true});await node.focus();await node.press('Enter');
  await page.getByRole('button',{name:'Generate take',exact:true}).click();
  const generation=page.getByRole('dialog',{name:'Generate a new take',exact:true});
  await expect(generation.getByRole('combobox',{name:'Generation engine',exact:true})).toHaveValue('gemini-3-pro-image');
  await expect(generation.getByRole('button',{name:'Generate · 3 cr estimated',exact:true})).toBeEnabled();
  await expect(generation.getByRole('combobox',{name:'Identity',exact:true})).toHaveCount(0);
});

test('Soul training limits copied metadata without changing the original asset',async({page},info)=>{
  test.skip(info.project.name!=='workbench-1440x900','one copied metadata regression');
  const f=await fixture(page);
  const headers={'X-Workbench-Scope':f.scope};
  const draft=await page.request.get(`/api/workbench/projects?id=${f.project.id}`,{headers}).then(response=>response.json());
  const name='Mira '+ 'character study '.repeat(8).trim(),description='Keep the original detailed continuity notes. '.repeat(60);
  draft.project.assets[0].name=name;draft.project.assets[0].description=description;
  const saved=await page.request.put('/api/workbench/projects',{headers,data:{project:draft.project,revision:draft.revision}});
  expect(saved.ok(),await saved.text()).toBe(true);
  await page.goto('/workbench');await goWorkbenchStage(page,'characters');
  await page.getByRole('button',{name:`Actions for ${name}`,exact:true}).click();
  await page.getByRole('menuitem',{name:'Attach identity',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Identity',exact:true});
  await expect(panel.getByRole('textbox',{name:'Identity name',exact:true})).toHaveValue(name.slice(0,100));
  await expect(panel.getByRole('textbox',{name:'Identity continuity notes',exact:true})).toHaveValue(description.slice(0,1000));
  await expect(panel.getByRole('textbox',{name:'Identity name',exact:true})).toHaveAttribute('maxlength','100');
  await expect(panel.getByRole('textbox',{name:'Identity continuity notes',exact:true})).toHaveAttribute('maxlength','1000');
  await panel.getByRole('button',{name:'Close',exact:true}).click();
  expect((await f.current()).assets[0]).toMatchObject({name,description});
  expect(f.requests()).toBe(0);
});
