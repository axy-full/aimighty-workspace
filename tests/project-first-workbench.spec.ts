import {test,expect,type Page} from '@playwright/test';
import {signInLocally} from './helpers/workbenchLocal';
import {newProject,type Project} from '../lib/workbench/studio';

async function fixture(page:Page, failure:'none'|'lost'|'offline'|'conflict'|'load'='none') {
 await signInLocally(page.request);
 const me=await page.request.get('/api/me').then(r=>r.json());
 let draft:Project={...newProject('Project first fixture'),productionProjectId:'project-browser',shotMappings:{}};
 let revision=1,writes=0,failed=false;
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  const json=(data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(path==='/api/me')return json(me);
  if(path==='/api/workbench/projects'){
   if(req.method()==='GET'&&failure==='load'&&!failed){failed=true;return route.abort('internetdisconnected');}
   if(req.method()==='PUT'){
    writes++;const body=req.postDataJSON();
    if(failure==='offline'&&!failed){failed=true;return route.abort('internetdisconnected');}
    if(failure==='conflict'&&!failed){failed=true;draft={...draft,name:'Other window'};revision++;return route.abort('failed');}
    if(body.revision!==revision)return json({error:'This project changed in another window.'},409);
    draft={...body.project,productionProjectId:'project-browser',shotMappings:{}};revision++;
    if(failure==='lost'&&!failed){failed=true;return route.abort('failed');}
    return json({revision,productionProjectId:draft.productionProjectId,shotMappings:{}});
   }
   return json({project:draft,revision,projects:[{id:draft.id,name:draft.name}],productions:[]});
  }
  if(path==='/api/workbench/atomik')return json({models:[],jobs:[]});
  if(path==='/api/workbench/development')return json({configured:true,models:[],jobs:[]});
  if(path==='/api/jobs')return json({generations:[],nextCursor:null});
  if(path==='/api/uploads')return json({uploads:[],nextCursor:null});
  if(path==='/api/workbench/library')return json({uploads:[],generations:[],nextPageCursor:null,nextCursor:null});
  if(path==='/api/projects')return json({projects:[{id:'project-browser',name:draft.name}]});
  if(path==='/api/atomik/chats')return json({chats:[]});
  if(path==='/api/audio')return json({voices:[],sound:true,music:true});
  if(path==='/api/quotes')return json({quotes:[]});
  if(path==='/api/workbench/engines')return json({models:[]});
  if(path==='/api/budget')return json({allowed:true});
  return json({});
 });
 await page.goto(`/workbench?project=${draft.id}&stage=brief`);
 await expect(page.locator('#project-name')).toHaveValue('Project first fixture');
 return {id:draft.id,errors,get writes(){return writes;},get project(){return draft;}};
}

test('project selector precedes controls and All assets sits beside Atomik',async({page},info)=>{
 const f=await fixture(page);
 const mobile=(info.project.use.viewport?.width??1440)<760;
 const bar=await page.locator('.project-bar').boundingBox(),body=await page.locator('.workspace-body').boundingBox();
 expect(bar!.y+bar!.height).toBeLessThanOrEqual(body!.y+1);
 await expect(page.getByRole('navigation',{name:'Rooms',exact:true}).getByRole('link',{name:'Make',exact:true})).toBeVisible();
 const allButton=page.locator('.project-bar').getByRole('button',{name:'All assets',exact:true});
 await expect(allButton).toBeVisible();
 if(!mobile){
  const all=await allButton.boundingBox(),atomik=await page.locator('.project-bar').getByRole('button',{name:'Toggle Atomik creative engine'}).boundingBox();
  expect(all!.x+all!.width).toBeLessThan(atomik!.x);expect(Math.abs(all!.y-atomik!.y)).toBeLessThan(5);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('project-first.png')});expect(f.errors).toEqual([]);
});

test('Atomik resizes with keyboard and pointer and remembers width',async({page},info)=>{
 const f=await fixture(page);const mobile=(info.project.use.viewport?.width??1440)<760;
 await page.getByRole('button',{name:'Toggle Atomik creative engine',exact:true}).filter({visible:true}).click();
 const handle=page.getByRole('separator',{name:'Resize Atomik panel'});await expect(handle).toBeVisible();
 const before=Number(await handle.getAttribute('aria-valuenow'));await handle.focus();await page.keyboard.press(mobile?'ArrowUp':'ArrowLeft');
 await expect.poll(async()=>Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
 const box=await handle.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width/2-(mobile?0:60),box!.y+box!.height/2-(mobile?35:0),{steps:5});await page.mouse.up();
 const resized=Number(await handle.getAttribute('aria-valuenow'));expect(resized).toBeGreaterThan(before);
 if(!mobile){await page.getByRole('button',{name:'Toggle Atomik creative engine',exact:true}).click();await page.getByRole('button',{name:'Toggle Atomik creative engine',exact:true}).click();await expect(handle).toHaveAttribute('aria-valuenow',String(resized));}
 await page.screenshot({path:info.outputPath('atomik-resized.png')});
 await page.reload();await expect(page.locator('#project-name')).toHaveValue('Project first fixture');await page.getByRole('button',{name:'Toggle Atomik creative engine',exact:true}).filter({visible:true}).click();await expect(handle).toHaveAttribute('aria-valuenow',String(resized));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(f.errors).toEqual([]);
});

for(const failure of ['lost','offline','conflict'] as const)test(`save recovery keeps edits after ${failure}`,async({page},info)=>{
 test.skip(info.project.name!=='workbench-1440x900','one desktop save concurrency rehearsal');
 const f=await fixture(page,failure);await page.locator('#project-name').fill('Local edited project');
 if(failure==='conflict'){
  await expect(page.locator('.save-banner')).toContainText('another window');await expect(page.locator('#project-name')).toHaveValue('Local edited project');expect(f.project.name).toBe('Other window');expect(f.writes).toBe(1);
 }else{
  await expect(page.locator('.project-bar .save-label')).toHaveText('Saved',{timeout:12000});await expect(page.locator('#project-name')).toHaveValue('Local edited project');expect(f.project.name).toBe('Local edited project');expect(f.writes).toBe(failure==='lost'?1:2);await expect(page.locator('.save-banner')).toHaveCount(0);
 }
 expect(f.errors).toEqual([]);
});

test('Library and Production navigation retain the selected project',async({page},info)=>{
 test.skip(info.project.name!=='workbench-1440x900','one desktop route roundtrip');
 const f=await fixture(page);
 await page.getByRole('navigation',{name:'Rooms',exact:true}).getByRole('link',{name:'Library',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('/library\\?all=1&project='+f.id));
 await expect(page.getByRole('button',{name:'Select project'})).toContainText('Project first fixture');
 await expect(page.getByRole('region',{name:'Collective workspace assets'})).toBeVisible();
 await page.getByRole('navigation',{name:'Rooms',exact:true}).getByRole('link',{name:'Production',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('/workbench\\?project='+f.id+'&stage=brief'));
 await expect(page.locator('#project-name')).toHaveValue('Project first fixture');
 await expect(page.getByRole('navigation',{name:'Particl Studio pages',exact:true}).getByRole('link',{name:'Brief',exact:true})).toHaveAttribute('aria-current','page');expect(f.errors).toEqual([]);
});

test('Atomik remains resizable inside the project library',async({page},info)=>{
 test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'one phone and one desktop project tool');
 const f=await fixture(page),mobile=(info.project.use.viewport?.width??1440)<760;
 await page.goto(`/library?project=${f.id}`);
 await expect(page.getByRole('button',{name:'Select project'})).toContainText('Project first fixture');
 const toggle=page.getByRole('button',{name:'Toggle Atomik creative engine'});
 await toggle.click();
 const handle=page.getByRole('separator',{name:'Resize Atomik panel'}).filter({visible:true});
 await expect(handle).toBeVisible();
 const before=Number(await handle.getAttribute('aria-valuenow'));
 await handle.focus();await page.keyboard.press(mobile?'ArrowUp':'ArrowLeft');
 await expect.poll(async()=>Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
 const box=await handle.boundingBox();
 await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();
 await page.mouse.move(box!.x+box!.width/2-(mobile?0:35),box!.y+box!.height/2-(mobile?25:0),{steps:5});await page.mouse.up();
 const resized=await handle.getAttribute('aria-valuenow');
 if(mobile)await page.getByRole('dialog',{name:'Atomik',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
 else await page.getByRole('button',{name:'Close Atomik',exact:true}).click();
 await toggle.click();await expect(handle).toHaveAttribute('aria-valuenow',resized!);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('library-atomik-resized.png')});expect(f.errors).toEqual([]);
});

 test('initial project load reconnects after a transient connection failure',async({page},info)=>{
  test.skip(info.project.name!=='workbench-1440x900','one initial-load recovery check');
  const f=await fixture(page,'load');await expect(page.locator('.save-banner')).toHaveCount(0);await expect(page.locator('.project-bar .save-label')).toHaveText('Saved');expect(f.writes).toBe(0);expect(f.errors).toEqual([]);
 });
