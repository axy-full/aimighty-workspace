import type { AstraNativeSource, AstraNativeProposal } from '../astra-blender/native';
import type { AstraScene } from '../astra-blender/scene';
import type { AstraProposal } from '../astra-blender/proposal';
import type { SuiteAgentPlan } from './suite-agent-plan';
import type {MoleculrBrief} from './moleculr';
import type {AssetBin} from './editorial';
import type {MarketingBrief} from './marketing-brief';
export type {MarketingBrief} from './marketing-brief';
import {validateColor, type ColorGrade} from './color';
import {validateAudio, type AudioClip} from './audio';
import type {ScriptSource, SceneReview} from './screenplay';
import {PARTICL_STAGE_ALIASES} from '../suites';
export type Stage = 'brief' | 'script' | 'moodboard' | 'characters' | 'elements' | 'astra-blender' | 'canvas' | 'storyboard' | 'assets' | 'edit' | 'export';
export type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'link';
export type AssetStatus = 'Draft' | 'Selected' | 'Continuity note';
export type Asset = { id:string; name:string; kind:AssetKind; category:string; url:string; description:string; prompt:string; status:AssetStatus; locked:boolean; version:number; refs:string[]; parentId?:string; mime?:string; uploadId?:string; generationId?:string; soulIdentityId?:string; productionShotId?:string; nodeId?:string; /** The stored original's own length in seconds (audio and video), when the server could read it. */ seconds?:number };
export type NodeType = 'brief'|'moodboard'|'character'|'element'|'scene'|'note'|'media'|'generate'|'merge'|'grade'|'transform'|'audio'|'switch'|'review'|'output';
export type NodeOperation = {id:string;kind:'direction'|'grade'|'transform'|'mask'|'mix';enabled:boolean;values:Record<string,number|string|boolean>};
export type NodeVersion = {id:string;label:string;assetId?:string;text?:string;operations:NodeOperation[];savedAt:string};
export type CanvasNode = {id:string; title:string; type:NodeType; assetId?:string; text?:string;developmentSource?:{jobId:string;sourceHash:string;sceneId:string;sourceAssetId?:string;sourceStart:number;sourceEnd:number};scriptScene?:{id:string;sourceKey:string;sourceAssetId?:string;pageStart?:number;pageEnd?:number}; x:number; y:number; width:number; linked:string[];operations?:NodeOperation[];bypassed?:boolean;locked?:boolean;collapsed?:boolean;role?:string;mode?:string;status?:'draft'|'review'|'approved';versions?:NodeVersion[];activeInput?:string} & ShotFields;
/** Optional render settings a Rig shot (a scene or generate node) carries. Absent on every draft saved before them; lib/workspace/shots.ts fills engine defaults on read. */
export type ShotFields = {/** A look name, or the id of a look board (moodboard) node. */ look?:string; /** A catalogue model id (lib/models.ts). */ engine?:string; /** Seconds; clamped to the engine's catalogue range by lib/workspace. */ durationS?:number; ratio?:string; resolution?:string};
/** The node types the Rig lists as shots: the graph's Create family (NODE_DEFS), the nodes that render. */
export const SHOT_NODE_TYPES = ['scene','generate'] as const satisfies readonly NodeType[];
export type Shot = {id:string; name:string; assetId:string; duration:number; sourceIn:number; note:string};
export type Plan = {astraNative?:AstraNativeProposal;astraBlender?:AstraProposal;referenceAdAnalysis?:import('./reference-ad-analysis').ReferenceAdAnalysis;suiteAgent?:SuiteAgentPlan;id:string; request:string; model:string; depth:string; effort?:string; intent:string; summary:string; steps:string[]; applied:boolean; refs:string[]; role?:string};
/** Production suite state (owner's brief, 23 September): what the director approved at each gate. */
export type ScriptApproval = { at: string; source: 'agent' | 'hand'; jobId?: string; sha256: string };
export type Production = { scriptApproval?: ScriptApproval; beats?: import('../production/beats').BeatSheet };
export type Project = {production?:Production;astraNative?:AstraNativeSource;astraBlender?:AstraScene;moleculr?:MoleculrBrief;marketingBrief?:MarketingBrief;bins?:AssetBin[];colorGrade?:ColorGrade;productionProjectId?:string; shotMappings?:Record<string,string>; bibleVersion?:number; id:string; name:string; description:string; brief:string; audience:string; deliverables:string; direction:string; fps:number; aspect:string; assets:Asset[]; nodes:CanvasNode[]; shots:Shot[]; plans:Plan[]; briefPinned:boolean; lookPinned:boolean; createdAt:string; sharedAssetIds:string[]; sharedNodeIds:string[]; audioAssetId?:string; audioClips?:AudioClip[]; clipAudio?:boolean; script?:string;scriptFormat?:'screenplay'|'adfilm';scriptSource?:ScriptSource;scriptReviews?:Record<string,SceneReview>;developmentApplications?:string[]; sharedNodes?:CanvasNode[]; sharedAssets?:Asset[]};
/** The visible production stages, in dock order. Retired IDs stay in `Stage` as aliases (see `normalizeStage`). */
export const STAGES: {id:Stage; label:string; hint:string}[] = [
 {id:'brief',label:'Brief & Script',hint:'Find the story and the production in it'},
 {id:'storyboard',label:'Boards',hint:'Define the visual world and plan every frame'},
 {id:'characters',label:'Cast & Elements',hint:'Keep identity consistent and build a reusable world'},
 {id:'astra-blender',label:'Astra',hint:'Shape your scene with GPT-6 Astra'},
 {id:'canvas',label:'Rig',hint:'Bring it all together'},
 {id:'assets',label:'Takes',hint:'Select the right take'},
 {id:'edit',label:'Edit & Sound',hint:'Shape the story'},
 {id:'export',label:'Deliver',hint:'Ready for the next room'}];
/** Former stage IDs (`script`, `moodboard`, `elements`) open the visible stage that now holds their panel. */
export const STAGE_ALIASES = PARTICL_STAGE_ALIASES as Record<string, Stage>;
export function normalizeStage(value: string | null | undefined): Stage | null {
 if (!value) return null;
 if (STAGES.some(stage => stage.id === value)) return value as Stage;
 return STAGE_ALIASES[value] ?? null;
}
export function isVisibleStage(value: Stage): boolean { return STAGES.some(stage => stage.id === value); }
export function uid(prefix='id') {return prefix+'-'+crypto.randomUUID().slice(0,8)}
export function seedProject():Project {const p:Project={
 id:'dune-studies',name:'Dune Studies',description:'Fashion film · Concept 01',script:'EXT. MIRRORED DUNES - LATE AFTERNOON\n\nCaramel dunes stretch into the distance. A monumental chrome sphere reflects the empty horizon. Hold for four seconds.\n\nEXT. MIRRORED DUNES - CONTINUOUS\n\nMIRA, wearing an ivory tailored suit and long scarf, enters the frame. She approaches the sphere. Fabric catches the wind. Six seconds.\n\nMIRA\nWhat if the world saw you differently?\n\nEXT. MIRROR SPHERE - LATE AFTERNOON\n\nHer reflection moves across the surface. The camera holds. Five seconds. Leave room for the end line.',
 brief:'A 15-second fashion film about quiet confidence in an extraordinary world. A woman crosses a sculptural desert landscape. A mirror sphere reflects the world around her. Her presence changes the way we see it.',
 audience:'Design-conscious audiences, 25–40. Premium fashion and culture.',
 deliverables:'15s hero film · 6s cutdown · 3 campaign stills · 16:9 and 9:16',
 direction:'Sculptural landscapes. An ivory silhouette. Impossible reflections. Warm, low sunlight, considered movement and the texture of 35mm film. No logos or typography in generated plates.',
 fps:24,aspect:'16:9',sharedAssetIds:['environment'],sharedNodeIds:['look','world'],briefPinned:true,lookPinned:false,createdAt:'2026-09-13T00:00:00Z',
 assets:[
  {id:'hero',name:'The encounter',kind:'image',category:'Shot',url:'/campaign/hero.webp',description:'Wide composition · 35mm · Late afternoon',prompt:'An ivory-suited woman walks through caramel dunes beside a monumental mirror sphere. Soft late-afternoon sunlight. Preserve a short dark bob, ivory suit and long scarf. Wide composition, tactile 35mm film.',status:'Continuity note',locked:false,version:1,refs:['character','environment']},
  {id:'character',name:'Mira / character study',kind:'image',category:'Character',url:'/campaign/character.webp',description:'Front · Three-quarter · Profile',prompt:'Character continuity reference: adult woman, short dark bob, ivory tailored suit with straight trousers, long ivory scarf. Natural expression. Neutral studio. Match the inner layer to the selected hero before final project.',status:'Draft',locked:false,version:1,refs:[]},
  {id:'environment',name:'The mirrored dunes',kind:'image',category:'Environment',url:'/campaign/environment.webp',description:'Environment plate · Warm daylight',prompt:'Sculptural caramel sand dunes, a monumental mirror-polished chrome sphere on the right, pale blue sky. No people. Low warm sun, realistic reflections, tactile fine grain.',status:'Selected',locked:true,version:1,refs:[]}
 ],
 nodes:[
  {id:'look',title:'A world out of the ordinary',type:'moodboard',assetId:'environment',text:'Warm sand. Cool chrome. Quiet confidence.',x:40,y:60,width:270,linked:[]},
  {id:'cast',title:'Mira / character sheet',type:'character',assetId:'character',x:40,y:384,width:270,linked:[]},
  {id:'scene',title:'The encounter',type:'scene',assetId:'hero',text:'Mira enters. The landscape becomes a reflection.',x:374,y:88,width:344,linked:['look','cast','world']},
  {id:'world',title:'The mirrored dunes',type:'element',assetId:'environment',x:40,y:708,width:270,linked:[]},
  {id:'direction',title:'Director’s note',type:'note',text:'Let the world feel impossible.\nLet her feel completely real.\n\nHold the frame. Give the fabric room to move.',x:374,y:469,width:344,linked:['scene']},
  {id:'colour',title:'Desert daylight',type:'grade',x:782,y:99,width:236,linked:['scene'],role:'Colourist',operations:[{id:'sample-colour',kind:'grade',enabled:true,values:{brightness:103,contrast:105,saturation:90}}]},
  {id:'continuity',title:'Continuity review',type:'review',x:782,y:299,width:236,linked:['colour'],role:'Director',status:'review',text:'Check the inner suit layer against the selected character reference.'},
  {id:'result',title:'Hero output',type:'output',x:782,y:489,width:236,linked:['continuity'],role:'Editor'}
 ],
 shots:[
 {id:'s01',name:'01 — A different world',assetId:'environment',duration:96,sourceIn:0,note:'Wide establishing frame. The sphere catches the first light.'},
 {id:'s02',name:'02 — The encounter',assetId:'hero',duration:144,sourceIn:0,note:'Mira walks into frame. Hold the camera. Let the scarf move.'},
 {id:'s03',name:'03 — Leave an impression',assetId:'hero',duration:120,sourceIn:0,note:'Resolve on her reflection. Leave space for the end line.'}],plans:[]};return {...p,sharedNodes:structuredClone(p.nodes.filter(n=>p.sharedNodeIds.includes(n.id))),sharedAssets:structuredClone(p.assets.filter(a=>p.sharedAssetIds.includes(a.id)))};}
export function newProject(name:string):Project {const p=seedProject();return {...p,id:uid('project'),name,description:'New project',brief:'',script:'',audience:'',deliverables:'',direction:'',briefPinned:false,lookPinned:false,assets:[],nodes:[],shots:[],plans:[],sharedAssetIds:[],sharedNodeIds:[],sharedAssets:[],sharedNodes:[],createdAt:new Date().toISOString()};}
export function timecode(frame:number,fps:number) {const f=Math.max(0,Math.round(frame));return [Math.floor(f/(fps*3600)),Math.floor(f/(fps*60))%60,Math.floor(f/fps)%60,f%fps].map(n=>String(n).padStart(2,'0')).join(':');}
export function safeName(s:string){return s.replace(/[^a-zA-Z0-9_.-]+/g,'_').slice(0,90)||'asset'}
export function assetFilename(a:Asset){const ext:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/avif':'avif','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/mp4':'m4a','audio/ogg':'ogg','application/pdf':'pdf','text/plain':'txt','model/gltf-binary':'glb','application/x-blender':'blend'};const suffix=(a.kind==='document'&&/\.cube$/i.test(a.name)?'cube':undefined)||ext[a.mime||'']||a.url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]||(a.kind==='video'?'mp4':a.kind==='audio'?'mp3':'png');return safeName(a.id)+'_'+safeName(a.name.replace(/\.[a-zA-Z0-9]{2,5}$/,''))+'.'+suffix;}
/** Validate the edit before exporting: a missing source must never become a fictitious filename. */
export function validateSequence(p:Project):void {
 validateColor(p);
 if(![24,25,30].includes(p.fps))throw new Error('Choose 24, 25 or 30 fps for a non-drop-frame EDL.');
 if(!p.shots.length)throw new Error('Add a shot before exporting.');
 if(p.shots.length>999)throw new Error('A CMX3600 EDL supports up to 999 events.');
 const assets=new Map<string,Asset>();
 for(const asset of p.assets){if(assets.has(asset.id))throw new Error('Two assets have the same ID. Resolve the duplicate before exporting.');assets.set(asset.id,asset);}
 let record=p.fps*3600;const day=24*3600*p.fps;
 for(const shot of p.shots){
  const asset=assets.get(shot.assetId);
  if(!asset)throw new Error('The source for '+shot.name+' is missing. Choose another asset before exporting.');
  if(!['image','video'].includes(asset.kind))throw new Error(shot.name+' needs an image or video source.');
  if(!Number.isSafeInteger(shot.duration)||shot.duration<1||!Number.isSafeInteger(shot.sourceIn)||shot.sourceIn<0)throw new Error('Use a positive whole-frame duration and non-negative source in for '+shot.name+'.');
  if(shot.sourceIn+shot.duration>=day||record+shot.duration>=day)throw new Error('The edit exceeds the 24-hour CMX3600 timecode range.');
  record+=shot.duration;
 }
 if(p.audioAssetId&&assets.get(p.audioAssetId)?.kind!=='audio')throw new Error('The sequence scratch audio is missing or is not an audio file.');
 validateAudio(p);
}
export function makeEDL(p:Project) {
 validateSequence(p);
 let record=p.fps*3600;
 const lines=['TITLE: '+safeName(p.name).toUpperCase(),'FCM: NON-DROP FRAME',''];
 const reelIds=new Map<string,string>();
 p.shots.forEach((shot,i)=>{
  const asset=p.assets.find(a=>a.id===shot.assetId)!;
  if(!reelIds.has(asset.id))reelIds.set(asset.id,'P'+String(reelIds.size+1).padStart(7,'0'));
  lines.push(`${String(i+1).padStart(3,'0')}  ${reelIds.get(asset.id)} V     C        ${timecode(shot.sourceIn,p.fps)} ${timecode(shot.sourceIn+shot.duration,p.fps)} ${timecode(record,p.fps)} ${timecode(record+shot.duration,p.fps)}`);
  lines.push('* FROM CLIP NAME: '+assetFilename(asset));
  lines.push('* COMMENT: '+shot.note.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300),'');
  record+=shot.duration;
 });
 return lines.join('\r\n');
}
export function demoPlan(request:string,p:Project,model:string,depth:string,refs:string[]):Plan {
 const intent=/continuity|consistent|match|wardrobe|check/i.test(request)?'continuity':/shot|storyboard|sequence/i.test(request)?'shots':/edit|change|replace|reframe|light/i.test(request)?'revision':'campaign';
 const steps=intent==='continuity'?['Compare the selected takes against character and environment references.','Review the inner suit layer: the supplied character study and hero use different tops.','Check sphere reflections, scarf length, sun direction and screen direction.','Keep final decisions with the director; record any mismatch as a review note.']:intent==='shots'?['Open on an environment wide. Give the world four seconds to register.','Introduce the character in a six-second hero shot with restrained movement.','Resolve on a five-second detail or reflection. Retain room for the end line.','Attach the character, world and look references to each proposed shot.']:intent==='revision'?['Keep the original take and create a separate revision note.','Carry the selected references and identity constraints into the edit brief.','Review the requested change against the original frame before replacing a select.','Use the asset editor for crop and colour; generative changes require a connected image model.']:['Establish one core idea and a visual rulebook from the project brief.','Build a moodboard with palette, lighting, framing and material references.','Define reusable character and element sheets, with continuity notes.','Connect the references into a hero scene and a three-shot sequence.','Review selected takes, assemble an animatic and export a cut list.'];
 return {id:uid('plan'),request,model,depth,intent,summary:intent==='continuity'?'A continuity review to protect the visual decisions already made.':intent==='revision'?'A separate revision keeps the selected take intact.':intent==='shots'?'A three-beat structure: establish the world, introduce the character, leave an impression.':`A project plan for ${p.name}, built around a repeatable visual world.`,steps,applied:false,refs};
}
