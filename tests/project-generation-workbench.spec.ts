import { test, expect, type Page } from '@playwright/test';
test.setTimeout(45_000);
test.beforeEach(({page}) => { page.setDefaultTimeout(12_000); });
import { signInLocally } from './helpers/workbenchLocal';
import { newProject, type Project } from '../lib/workbench/studio';
import { goWorkbenchStage } from './helpers/workbenchNavigation';

async function fixture(page:Page) {
 await signInLocally(page.request);
 const me=await page.request.get('/api/me').then(r=>r.json()),scope=`particl-active-${me.workspace.id}-${me.id}`;
 let project:Project={...newProject('Generation project'),id:'generation-fixture',productionProjectId:'production-fixture',shotMappings:{'generate-node':'shot-fixture'},
  assets:[{id:'portrait',uploadId:'portrait-upload',name:'Original portrait',kind:'image',category:'Reference',url:'/campaign/character.webp',description:'',prompt:'',status:'Draft',locked:false,version:1,refs:[]}],
  nodes:[{id:'reference-node',type:'media',title:'Original portrait',assetId:'portrait',x:80,y:440,width:280,linked:[]},{id:'generate-node',type:'generate',title:'Evening scene',text:'Rain on a quiet street',mode:'Audio',x:80,y:80,width:320,linked:['reference-node']}]};
 let revision=1,loseAudio=true,finishedAudio=false;
 const submissions:{endpoint:string;body:string;key:string|undefined;scope:string|undefined}[]=[];
 const upload={id:'portrait-upload',filename:'Original portrait',kind:'image',mime:'image/webp',bytes:1000,width:512,height:512,durationS:null,sha256:'fixture',url:'/campaign/character.webp',createdAt:1};
 const audioJob={id:'audio-fixture',status:'succeeded',kind:'audio',projectId:project.productionProjectId,shotId:'shot-fixture',prompt:'Rain on a quiet street',model:'elevenlabs:sound',version:1,params:{task:'sound'},createdAt:Date.now(),storedUrl:'/api/media/audio-fixture'};
 await page.addInitScript(({scope,id})=>localStorage.setItem(scope,id),{scope,id:project.id});
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  const json=(value:unknown,status=200,headers?:Record<string,string>)=>route.fulfill({json:value,status,headers});
  if(path==='/api/me')return json(me);
  if(path==='/api/workbench/projects'){
   if(req.method()==='PUT'){project=req.postDataJSON().project;return json({revision:++revision,productionProjectId:project.productionProjectId,shotMappings:project.shotMappings});}
   if(req.method()==='POST')return json({productionProjectId:'production-fixture',shotId:'shot-fixture'});
   return json({project,revision,projects:[{id:project.id,name:project.name}],productions:[]});
  }
  if(path==='/api/workbench/engines')return url.searchParams.has('model')?json({credits:3}):json({models:[{id:'dreamina-seedance-2-5-260628',label:'Motion 2.5',kind:'video',family:'seedance-2',resolutions:['720p'],ratios:['16:9'],durations:[5],maxReferenceImages:9,maxReferenceVideos:3}]});
  if(path==='/api/audio'&&req.method()==='GET')return json({configured:true,voices:[{id:'voice123456',name:'Fixture voice',labels:{},description:'Fixture voice'}],speechModels:[{id:'eleven_multilingual_v2',label:'Speech'}],defaultSpeechModel:'eleven_multilingual_v2',voicesError:null,terms:{sfxCredits:3,musicCreditsPerMinute:20},account:null});
  if(path==='/api/audio'&&req.method()==='POST'&&req.postDataJSON().quoteOnly)return json({estimatedCredits:3,price:3,unit:'cr'});
  if((path==='/api/generate'||path==='/api/audio')&&req.method()==='POST'){
   submissions.push({endpoint:path,body:req.postData()!,key:req.headers()['idempotency-key'],scope:req.headers()['x-workbench-scope']});
   if(path==='/api/audio'&&loseAudio){loseAudio=false;return json({error:'Lost response; recover the saved request.'},503);}
   if(path==='/api/audio')finishedAudio=true;
   return json({id:path==='/api/audio'?'audio-fixture':'visual-fixture',status:'running'},202,{'Idempotency-Status':'complete'});
  }
  if(path==='/api/workbench/library')return json({projectId:project.id,uploads:[upload],generations:finishedAudio?[audioJob]:[],nextCursor:null,nextPageCursor:null});
  if(path==='/api/uploads/portrait-upload/metadata')return json({upload});
  if(path==='/api/uploads/portrait-upload')return route.fulfill({status:302,headers:{Location:'/campaign/character.webp'}});
  if(path==='/api/jobs')return json({generations:finishedAudio?[audioJob]:[],nextCursor:null});
  if(path==='/api/jobs/audio-fixture')return json({generation:audioJob});
  if(path==='/api/workbench/atomik')return json({models:[],jobs:[]});
  if(path==='/api/productions')return json({productions:[]});
  if(path==='/api/cast')return json({cast:[]});
  if(path==='/api/media/audio-fixture')return route.fulfill({status:200,contentType:'audio/wav',body:Buffer.alloc(44)});
  return json({});
 });
 return {scope,me,submissions,current:()=>project};
}
async function openNode(page:Page) {
 await goWorkbenchStage(page,'canvas');
 if(page.viewportSize()!.width<760){await page.locator('.mobile-node-viewbar').getByRole('tab',{name:'List',exact:true}).click();await page.locator('.mobile-node-list button').filter({hasText:'Evening scene'}).click();}
 else {const node=page.getByRole('article',{name:'Generate node: Evening scene',exact:true});await node.focus();await node.press('Enter');}
 await page.getByRole('button',{name:'Generate take',exact:true}).click();
 return page.getByRole('dialog',{name:'Generate a new take',exact:true});
}
test('node audio keeps quote, project mapping and exact paid recovery across reload',async({page},info)=>{
 test.skip(!['workbench-360x640','workbench-1440x900'].includes(info.project.name),'bounded phone and desktop');
 const f=await fixture(page);await page.goto('/workbench?project=generation-fixture&stage=canvas');
 let dialog=await openNode(page);
 await expect(dialog.getByRole('combobox',{name:'Generation type'})).toHaveValue('audio');
 await expect(dialog.getByRole('button',{name:'Generate · 3 cr estimated',exact:true})).toBeEnabled();
 await dialog.getByRole('button',{name:'Generate · 3 cr estimated',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Recover submitted take',exact:true})).toBeVisible();
 expect(f.submissions).toHaveLength(1);
 expect(JSON.parse(f.submissions[0].body)).toMatchObject({task:'sound',projectId:'production-fixture',shotId:'shot-fixture',durationSeconds:10,maxCredits:3});
 expect(f.submissions[0].scope).toBe(f.scope);
 await page.reload();dialog=await openNode(page);
 await expect(dialog.getByRole('combobox',{name:'Generation type'})).toBeDisabled();
 await dialog.getByRole('button',{name:'Recover submitted take',exact:true}).click();
 await expect(dialog).not.toBeVisible();
 expect(f.submissions).toHaveLength(2);expect(f.submissions[1]).toEqual(f.submissions[0]);
 await expect.poll(()=>f.current().assets.find(a=>a.generationId==='audio-fixture')?.kind).toBe('audio');
 await expect.poll(()=>f.current().nodes.find(node=>node.id==='generate-node')?.assetId).toBe('audio-fixture');
 expect(f.current().nodes.find(node=>node.id==='reference-node')?.assetId).toBe('portrait');
 await page.goto('/generate?mode=audio&project=generation-fixture');
 if(page.viewportSize()!.width<760)await page.getByRole('button',{name:'Takes & assets',exact:true}).click();
 await page.getByRole('button',{name:'Generations',exact:true}).click();
 await page.getByRole('button',{name:/Preview Rain on a quiet street/}).click();
 await expect(page.getByRole('dialog').locator('audio')).toHaveAttribute('src','/api/media/audio-fixture?stream=1');
 await page.screenshot({path:info.outputPath('node-audio-recovered.png')});
});
test('Gen image actions distinguish ordinary reference and first frame in scoped paid payloads',async({page},info)=>{
 test.skip(info.project.name!=='workbench-1440x900','desktop context menu');
 const f=await fixture(page);await page.goto('/generate?mode=video&ref=upload%3Aportrait-upload');
 await expect(page).toHaveURL(/project=generation-fixture/);
 const ref=page.locator('[data-reference-id="upload:portrait-upload"]');await expect(ref).toBeVisible();
 const first=page.getByRole('combobox',{name:'First frame',exact:true});await expect(first).toHaveValue('');
 await ref.click({button:'right'});await page.getByRole('menuitem',{name:'Use as first frame',exact:true}).click();
 await expect(first).toHaveValue('upload:portrait-upload');
 await first.selectOption('');await expect(ref).toBeVisible();
 await ref.click({button:'right'});await page.getByRole('menuitem',{name:'Use as reference',exact:true}).click();
 await expect(first).toHaveValue('');
 await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Rain on a quiet street');
 await page.locator('[data-render]').click();
 await expect.poll(()=>f.submissions.length).toBe(1);
 expect(JSON.parse(f.submissions[0].body)).toMatchObject({projectId:'production-fixture',references:[{uploadId:'portrait-upload',role:'reference_image'}]});
 await page.goto('/generate?mode=video&project=generation-fixture&ref=upload%3Aportrait-upload');await expect(ref).toBeVisible();
 await first.selectOption('upload:portrait-upload');
 await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Rain on a quiet street');
 await page.locator('[data-render]').click();
 await expect.poll(()=>f.submissions.length).toBe(2);
 expect(JSON.parse(f.submissions[1].body)).toMatchObject({projectId:'production-fixture',references:[{uploadId:'portrait-upload',role:'first_frame'}]});
 expect(f.submissions[1].key).not.toBe(f.submissions[0].key);
 await page.screenshot({path:info.outputPath('gen-explicit-frame.png')});
});

test('project Gen recovers older unfiled audio requests without changing their destination or idempotency key',async({page},info)=>{
 test.skip(info.project.name!=='workbench-1440x900','bounded migration check');
 const f=await fixture(page);
 const oldScope=JSON.stringify([f.me.workspace.id,f.me.email,'audio']),surface=`make:${oldScope}`;
 const key=`particl:pending-generation:${JSON.stringify([oldScope,'unfiled',surface])}`;
 const saved={key:'legacy-audio-key',body:JSON.stringify({task:'sound',text:'Old rain',durationSeconds:5,projectId:null,shotId:null,maxCredits:3}),credits:3,price:3,unit:'cr'};
 await page.addInitScript(({key,saved})=>localStorage.setItem(key,JSON.stringify(saved)),{key,saved});
 await page.goto('/generate?mode=audio&project=generation-fixture');
 await expect(page.getByText('Its original destination and settings are preserved.',{exact:false})).toBeVisible();
 const recover=page.getByRole('button',{name:/^Recover submitted audio/});
 await recover.click();await expect(recover).toBeEnabled();await recover.click();
 await expect.poll(()=>f.submissions.length).toBe(2);
 for(const sent of f.submissions){expect(sent.body).toBe(saved.body);expect(sent.key).toBe(saved.key);}
 await expect(recover).not.toBeVisible();
});
