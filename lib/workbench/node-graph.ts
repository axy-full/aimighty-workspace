import {nodeRenderSize,MAX_NODE_RENDER_WORK_PIXELS,type NodeRenderResolution} from './node-render';
import {Asset,CanvasNode,NodeOperation,NodeType,NodeVersion,Project,uid} from './studio';

export type NodeDefinition={label:string;family:'References'|'Create'|'Finish'|'Flow';description:string;tools:string[];shape:'reference'|'scene'|'operator'|'text'|'flow';role:string};
export const NODE_DEFS:Record<NodeType,NodeDefinition>={
 brief:{label:'Brief',family:'References',description:'Story, constraints and creative direction',tools:['Write','Annotate','Reference'],shape:'text',role:'Director'},
 moodboard:{label:'Look board',family:'References',description:'Visual references, palette and look notes',tools:['Collect','Grade','Reference'],shape:'reference',role:'Art director'},
 character:{label:'Character',family:'References',description:'Identity, wardrobe and continuity in one place',tools:['Identity','Wardrobe','Versions'],shape:'reference',role:'Costume stylist'},
 element:{label:'World & element',family:'References',description:'Locations, props, materials and set details',tools:['Reference','Transform','Reuse'],shape:'reference',role:'Art director'},
 media:{label:'Media',family:'References',description:'A source asset with an editable tool stack',tools:['Import','Preview','Adjust'],shape:'reference',role:'Editor'},
 scene:{label:'Scene',family:'Create',description:'Bring the cast, world and direction into a shot',tools:['Compose','Direct','Version'],shape:'scene',role:'Director'},
 generate:{label:'Generate',family:'Create',description:'Image and motion prompts with bound references',tools:['Prompt','References','Handoff'],shape:'scene',role:'DOP'},
 merge:{label:'Composite',family:'Finish',description:'Blend two image inputs, mask and transform',tools:['Blend','Mask','Transform'],shape:'operator',role:'VFX artist'},
 grade:{label:'Colour',family:'Finish',description:'Brightness, contrast and saturation with bypass',tools:['Grade','Compare','Version'],shape:'operator',role:'Colourist'},
 transform:{label:'Transform',family:'Finish',description:'Scale, rotate, flip and isolate an image',tools:['Scale','Rotate','Mask'],shape:'operator',role:'Editor'},
 audio:{label:'Sound',family:'Finish',description:'Audition, set gain and assign a soundtrack',tools:['Listen','Gain','Sequence'],shape:'operator',role:'Sound designer'},
 switch:{label:'Switch',family:'Flow',description:'Route one of several inputs to the next node',tools:['Route','Compare','Bypass'],shape:'flow',role:'Editor'},
 review:{label:'Review',family:'Flow',description:'Review an input, record notes and approve',tools:['Inspect','Comment','Approve'],shape:'flow',role:'Director'},
 output:{label:'Output',family:'Flow',description:'Select a result for the sequence or image handoff',tools:['Preview','Sequence','Export'],shape:'flow',role:'Editor'},
 note:{label:'Direction',family:'Flow',description:'Notes, department ownership and creative intent',tools:['Write','Assign','Connect'],shape:'text',role:'Director'},
};
export const OP_LABELS={direction:'Direction',grade:'Colour correction',transform:'Transform',mask:'Mask',mix:'Composite'};
export function newOperation(kind:NodeOperation['kind']):NodeOperation{return {id:uid('op'),kind,enabled:true,values:kind==='grade'?{brightness:100,contrast:100,saturation:100}:kind==='transform'?{scale:100,rotation:0,flip:false}:kind==='mask'?{shape:'ellipse',size:80,invert:false}:kind==='mix'?{opacity:50,blend:'source-over'}:{note:''}};}
export function operationsFor(n:CanvasNode):NodeOperation[]{return n.operations??(n.type==='grade'?[{id:'grade-default',kind:'grade',enabled:true,values:{brightness:100,contrast:100,saturation:100}}]:n.type==='transform'?[{id:'transform-default',kind:'transform',enabled:true,values:{scale:100,rotation:0,flip:false}}]:n.type==='merge'?[{id:'mix-default',kind:'mix',enabled:true,values:{opacity:50,blend:'source-over'}}]:[]);}
export function createNode(type:NodeType,index:number,position={x:100,y:100}):CanvasNode{return {id:uid('node'),title:NODE_DEFS[type].label+' '+String(index+1).padStart(2,'0'),type,...position,width:NODE_DEFS[type].shape==='scene'?344:NODE_DEFS[type].shape==='operator'||NODE_DEFS[type].shape==='flow'?236:280,linked:[],operations:operationsFor({type} as CanvasNode),role:NODE_DEFS[type].role,status:'draft',text:type==='note'?'Add a direction for your crew.':''};}
/** What a node emits: text nodes carry direction, every other node carries media (an asset or a rendered result). */
export type NodeOutputKind='text'|'media';
export function nodeOutputKind(type:NodeType):NodeOutputKind{return NODE_DEFS[type].shape==='text'?'text':'media';}
/** What a node consumes and how many inputs it can hold. Operators take one raster, a composite takes background + foreground. */
export const NODE_INPUTS:Record<NodeType,{accepts:'any'|'media';max:number}>={
 brief:{accepts:'any',max:100},note:{accepts:'any',max:100},moodboard:{accepts:'any',max:100},character:{accepts:'any',max:100},element:{accepts:'any',max:100},media:{accepts:'any',max:100},
 scene:{accepts:'any',max:100},generate:{accepts:'any',max:100},review:{accepts:'any',max:100},switch:{accepts:'media',max:100},
 merge:{accepts:'media',max:2},grade:{accepts:'media',max:1},transform:{accepts:'media',max:1},audio:{accepts:'media',max:1},output:{accepts:'media',max:1},
};
export function canConnect(nodes:CanvasNode[],source:string,target:string):string|null{
 if(source===target)return 'A node cannot connect to itself.';
 const to=nodes.find(n=>n.id===target),from=nodes.find(n=>n.id===source);if(!to||!from)return 'Choose two existing nodes.';
 if(to.locked)return 'Unlock this node before changing its inputs.';
 if(to.linked.includes(source))return 'These nodes are already connected.';
 const rule=NODE_INPUTS[to.type],label=NODE_DEFS[to.type].label;
 if(rule.accepts==='media'&&nodeOutputKind(from.type)==='text')return label+' nodes take an image input, not a direction. Connect a media, scene or finishing node instead.';
 if(to.linked.length>=rule.max)return rule.max===1?label+' nodes take one input. Disconnect the current input first.':rule.max===2?label+' nodes take two inputs: background and foreground. Disconnect one first.':'This node has reached its input limit.';
 const seen=new Set<string>();const reaches=(id:string):boolean=>{if(id===target)return true;if(seen.has(id))return false;seen.add(id);return (nodes.find(n=>n.id===id)?.linked||[]).some(reaches);};
 return reaches(source)?'This connection would create a circular path.':null;
}
export const NODE_VERSION_LIMIT=30;
/** Labels count the versions ever saved, not the ones kept, so the label after the cap is still new. */
export function nextVersionLabel(versions:NodeVersion[]=[]){const highest=versions.reduce((max,v)=>{const match=/^Version (\d+)$/.exec(v.label);return match?Math.max(max,Number(match[1])):max;},0);return 'Version '+(Math.max(highest,versions.length)+1);}
/** Append a version under the cap and report the version it displaced, if any. */
export function appendNodeVersion(versions:NodeVersion[]=[],version:NodeVersion){const next=[...versions,version];const dropped=next.length>NODE_VERSION_LIMIT?next[0]:undefined;return {versions:next.slice(-NODE_VERSION_LIMIT),dropped};}
export function resolveAsset(n:CanvasNode,nodes:CanvasNode[],assets:Asset[],visited=new Set<string>()):Asset|undefined{
 if(visited.has(n.id))return;visited.add(n.id);
 const inputId=n.type==='switch'&&n.activeInput&&n.linked.includes(n.activeInput)?n.activeInput:n.linked[0];
 if(!n.bypassed&&n.type!=='switch'&&n.assetId){const a=assets.find(a=>a.id===n.assetId);if(a)return a;}
 const parent=nodes.find(p=>p.id===inputId);return parent?resolveAsset(parent,nodes,assets,visited):undefined;
}
export function hasImageTools(n:CanvasNode,nodes:CanvasNode[],visited=new Set<string>()):boolean{if(visited.has(n.id))return false;visited.add(n.id);if(!n.bypassed&&operationsFor(n).some(o=>o.enabled&&o.kind!=='direction'))return true;return n.linked.some(id=>{const source=nodes.find(v=>v.id===id);return !!source&&hasImageTools(source,nodes,visited)});}
export function nodeHeight(n:CanvasNode){if(n.collapsed)return 48;const shape=NODE_DEFS[n.type].shape;return shape==='scene'?340:shape==='reference'?286:shape==='text'?234:shape==='operator'?158:148;}
const ARRANGE_COLUMN=400,ARRANGE_GAP=38,ARRANGE_LEFT=60,ARRANGE_TOP=70;
/**
 * Column by longest input chain, rows in node order. Locked nodes keep their place and take no
 * slot; arranged nodes step below any locked node they would overlap. Cycles are broken at the
 * edge that returns to a node still on the stack, visiting nodes in id order so the result does
 * not depend on the array order.
 */
export function arrangeGraph(nodes:CanvasNode[]):CanvasNode[]{
 const byId=new Map(nodes.map(n=>[n.id,n] as const));const depth=new Map<string,number>();const stack=new Set<string>();
 const level=(n:CanvasNode):number=>{if(depth.has(n.id))return depth.get(n.id)!;if(stack.has(n.id))return -1;stack.add(n.id);let d=0;for(const id of [...n.linked].sort()){const parent=byId.get(id);if(!parent)continue;const pd=level(parent);if(pd>=0)d=Math.max(d,pd+1);}stack.delete(n.id);depth.set(n.id,d);return d;};
 for(const n of [...nodes].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))level(n);
 const locked=nodes.filter(n=>n.locked);const rows=new Map<number,number>();
 return nodes.map(n=>{if(n.locked)return n;const d=depth.get(n.id)||0,x=ARRANGE_LEFT+d*ARRANGE_COLUMN,width=n.width,height=nodeHeight(n);let y=rows.get(d)??ARRANGE_TOP;
  for(let guard=0;guard<locked.length+1;guard++){const hit=locked.find(l=>l.x<x+width&&l.x+l.width>x&&l.y<y+height&&l.y+nodeHeight(l)>y);if(!hit)break;y=hit.y+nodeHeight(hit)+ARRANGE_GAP;}
  rows.set(d,y+height+ARRANGE_GAP);return {...n,x,y};});
}
/** Everything the monitor preview depends on: the upstream chain's sources, routing and tool stacks. */
export function previewRenderKey(n:CanvasNode,nodes:CanvasNode[],assets:Asset[]):string{
 const seen=new Set<string>();const parts:string[]=[];
 const visit=(node:CanvasNode)=>{if(seen.has(node.id))return;seen.add(node.id);const asset=node.assetId?assets.find(a=>a.id===node.assetId):undefined;parts.push(JSON.stringify([node.id,node.type,node.bypassed?1:0,node.activeInput||'',node.linked,asset?[asset.id,asset.url,asset.kind]:null,operationsFor(node)]));for(const id of node.linked){const source=nodes.find(v=>v.id===id);if(source)visit(source);}};
 visit(n);return parts.join('|');
}
/** Bind every connected reference version once, including references behind finishing nodes. */
export function generationReferenceIds(n:CanvasNode,p:Project):string[]{
 const seenNodes=new Set<string>(),seenAssets=new Set<string>();
 const visit=(node:CanvasNode)=>{if(seenNodes.has(node.id))return;seenNodes.add(node.id);if(!node.bypassed&&node.type!=='switch'&&node.assetId&&p.assets.some(a=>a.id===node.assetId))seenAssets.add(node.assetId);const inputs=node.type==='switch'?[node.activeInput&&node.linked.includes(node.activeInput)?node.activeInput:node.linked[0]]:node.linked;for(const id of inputs){const source=p.nodes.find(value=>value.id===id);if(source)visit(source);}};
 visit(n);return [...seenAssets];
}
export function generationBrief(n:CanvasNode,p:Project){const upstream=n.linked.map(id=>p.nodes.find(v=>v.id===id)).filter(Boolean);return `PRODUCTION: ${p.name}\nNODE: ${n.title}\nOWNER: ${n.role||NODE_DEFS[n.type].role}\nMODE: ${n.mode||'Image'}\n\nPROJECT BRIEF\n${p.brief}\n\nDIRECTION\n${n.text||p.direction}\n\nCONNECTED REFERENCES\n${upstream.map(s=>`${s!.title}: ${s!.text||resolveAsset(s!,p.nodes,p.assets)?.prompt||'Source reference'} [${resolveAsset(s!,p.nodes,p.assets)?.url||'Text only'}]`).join('\n')}\n\nTOOL STACK\n${JSON.stringify(operationsFor(n),null,2)}`;}

// Each stage renders to its own canvas, preserving the source and stack order.
export async function renderNode(n:CanvasNode,p:Project,options:{resolution?:NodeRenderResolution;signal?:AbortSignal}={}):Promise<HTMLCanvasElement>{
 const cache=new Map<string,HTMLCanvasElement>();
 const check=()=>{if(options.signal?.aborted)throw new DOMException('The preview was cancelled.','AbortError');};
 let allocatedPixels=0;
 function allocate(width:number,height:number){
  // Include intermediate buffers, not only the final result, in this local budget.
  allocatedPixels+=width*height;
  if(allocatedPixels>MAX_NODE_RENDER_WORK_PIXELS)throw new Error('This image graph exceeds the local rendering memory limit. Use smaller sources or fewer image tools.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  if(!canvas.getContext('2d'))throw new Error('This browser cannot allocate the image canvas. Try a smaller source.');
  return canvas;
 }
 async function render(current:CanvasNode,visiting=new Set<string>()):Promise<HTMLCanvasElement>{
  check();if(cache.has(current.id))return cache.get(current.id)!;
  if(visiting.has(current.id))throw new Error('Circular node connection.');visiting.add(current.id);
  const inputs=current.linked.map(id=>p.nodes.find(v=>v.id===id)).filter(Boolean) as CanvasNode[];
  const primary=current.type==='switch'?inputs.find(v=>v.id===current.activeInput)||inputs[0]:inputs[0];
  let canvas:HTMLCanvasElement;
  const asset=!current.bypassed&&current.type!=='switch'?p.assets.find(a=>a.id===current.assetId):undefined;
  if(asset){
   if(asset.kind!=='image')throw new Error('Raster rendering requires a still image.');
   const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.crossOrigin='anonymous';image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Could not load the source image.'));image.src=asset.url;});
   const size=nodeRenderSize(img.naturalWidth,img.naturalHeight,options.resolution??'preview');
   check();canvas=allocate(size.width,size.height);canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);
  }else if(primary){const source=await render(primary,new Set(visiting));canvas=allocate(source.width,source.height);canvas.getContext('2d')!.drawImage(source,0,0);}
  else throw new Error('Attach an image or connect an image input to render this node.');
  if(!current.bypassed)for(const op of operationsFor(current).filter(o=>o.enabled&&o.kind!=='direction')){
   check();const next=allocate(canvas.width,canvas.height),ctx=next.getContext('2d')!,v=op.values;
   if(op.kind==='grade')ctx.filter=`brightness(${v.brightness??100}%) contrast(${v.contrast??100}%) saturate(${v.saturation??100}%)`;
   if(op.kind==='transform'){ctx.translate(next.width/2,next.height/2);ctx.rotate(Number(v.rotation||0)*Math.PI/180);ctx.scale(Number(v.scale??100)/100*(v.flip?-1:1),Number(v.scale??100)/100);ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);}
   else if(op.kind==='mask'){ctx.beginPath();if(v.invert)ctx.rect(0,0,next.width,next.height);const factor=Number(v.size??80)/100;if(v.shape==='rectangle')ctx.rect(next.width*(1-factor)/2,next.height*(1-factor)/2,next.width*factor,next.height*factor);else ctx.ellipse(next.width/2,next.height/2,next.width*factor/2,next.height*factor/2,0,0,2*Math.PI);ctx.clip(v.invert?'evenodd':'nonzero');ctx.drawImage(canvas,0,0);}
   else if(op.kind==='mix'){ctx.drawImage(canvas,0,0);if(inputs[1]){const layer=await render(inputs[1],new Set(visiting));ctx.globalAlpha=Number(v.opacity??50)/100;ctx.globalCompositeOperation=(v.blend||'source-over') as GlobalCompositeOperation;ctx.drawImage(layer,0,0,next.width,next.height);}}
   else ctx.drawImage(canvas,0,0);
   canvas=next;
  }
  cache.set(current.id,canvas);return canvas;
 }
 return render(n);
}
