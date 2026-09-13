import {Asset,CanvasNode,NodeOperation,NodeType,Project,uid} from './studio';

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
export function canConnect(nodes:CanvasNode[],source:string,target:string):string|null{
 if(source===target)return 'A node cannot connect to itself.';
 const to=nodes.find(n=>n.id===target);if(!to||!nodes.some(n=>n.id===source))return 'Choose two existing nodes.';
 if(to.locked)return 'Unlock this node before changing its inputs.';
 if(to.linked.includes(source))return 'These nodes are already connected.';
 if(to.linked.length>=100)return 'This node has reached its input limit.';
 const seen=new Set<string>();const reaches=(id:string):boolean=>{if(id===target)return true;if(seen.has(id))return false;seen.add(id);return (nodes.find(n=>n.id===id)?.linked||[]).some(reaches);};
 return reaches(source)?'This connection would create a circular path.':null;
}
export function resolveAsset(n:CanvasNode,nodes:CanvasNode[],assets:Asset[],visited=new Set<string>()):Asset|undefined{
 if(visited.has(n.id))return;visited.add(n.id);
 const inputId=n.type==='switch'&&n.activeInput&&n.linked.includes(n.activeInput)?n.activeInput:n.linked[0];
 if(!n.bypassed&&n.type!=='switch'&&n.assetId){const a=assets.find(a=>a.id===n.assetId);if(a)return a;}
 const parent=nodes.find(p=>p.id===inputId);return parent?resolveAsset(parent,nodes,assets,visited):undefined;
}
export function hasImageTools(n:CanvasNode,nodes:CanvasNode[],visited=new Set<string>()):boolean{if(visited.has(n.id))return false;visited.add(n.id);if(!n.bypassed&&operationsFor(n).some(o=>o.enabled&&o.kind!=='direction'))return true;return n.linked.some(id=>{const source=nodes.find(v=>v.id===id);return !!source&&hasImageTools(source,nodes,visited)});}
export function nodeHeight(n:CanvasNode){if(n.collapsed)return 50;const shape=NODE_DEFS[n.type].shape;return shape==='scene'?340:shape==='reference'?286:shape==='text'?234:shape==='operator'?158:148;}
export function arrangeGraph(nodes:CanvasNode[]):CanvasNode[]{const depth=new Map<string,number>();const level=(n:CanvasNode,seen=new Set<string>()):number=>{if(depth.has(n.id))return depth.get(n.id)!;if(seen.has(n.id))return 0;seen.add(n.id);const d=Math.min(12,n.linked.reduce((max,id)=>{const p=nodes.find(v=>v.id===id);return p?Math.max(max,level(p,new Set(seen))+1):max;},0));depth.set(n.id,d);return d;};nodes.forEach(n=>level(n));const rows=new Map<number,number>();return nodes.map(n=>{const d=depth.get(n.id)||0;const y=rows.get(d)||70;rows.set(d,y+nodeHeight(n)+38);return n.locked?n:{...n,x:60+d*400,y};});}
/** Bind every connected reference version once, including references behind finishing nodes. */
export function generationReferenceIds(n:CanvasNode,p:Project):string[]{
 const seenNodes=new Set<string>(),seenAssets=new Set<string>();
 const visit=(node:CanvasNode)=>{if(seenNodes.has(node.id))return;seenNodes.add(node.id);if(!node.bypassed&&node.type!=='switch'&&node.assetId&&p.assets.some(a=>a.id===node.assetId))seenAssets.add(node.assetId);const inputs=node.type==='switch'?[node.activeInput&&node.linked.includes(node.activeInput)?node.activeInput:node.linked[0]]:node.linked;for(const id of inputs){const source=p.nodes.find(value=>value.id===id);if(source)visit(source);}};
 visit(n);return [...seenAssets];
}
export function generationBrief(n:CanvasNode,p:Project){const upstream=n.linked.map(id=>p.nodes.find(v=>v.id===id)).filter(Boolean);return `PRODUCTION: ${p.name}\nNODE: ${n.title}\nOWNER: ${n.role||NODE_DEFS[n.type].role}\nMODE: ${n.mode||'Image'}\n\nPROJECT BRIEF\n${p.brief}\n\nDIRECTION\n${n.text||p.direction}\n\nCONNECTED REFERENCES\n${upstream.map(s=>`${s!.title}: ${s!.text||resolveAsset(s!,p.nodes,p.assets)?.prompt||'Source reference'} [${resolveAsset(s!,p.nodes,p.assets)?.url||'Text only'}]`).join('\n')}\n\nTOOL STACK\n${JSON.stringify(operationsFor(n),null,2)}`;}

// Each stage renders to its own canvas, preserving the source and stack order.
export async function renderNode(n:CanvasNode,p:Project,cache=new Map<string,HTMLCanvasElement>(),visiting=new Set<string>()):Promise<HTMLCanvasElement>{
 if(cache.has(n.id))return cache.get(n.id)!;if(visiting.has(n.id))throw new Error('Circular node connection.');visiting.add(n.id);
 const inputs=n.linked.map(id=>p.nodes.find(v=>v.id===id)).filter(Boolean) as CanvasNode[];
 const primary=n.type==='switch'?inputs.find(v=>v.id===n.activeInput)||inputs[0]:inputs[0];
 let canvas:HTMLCanvasElement;
 const asset=!n.bypassed&&n.type!=='switch'?p.assets.find(a=>a.id===n.assetId):undefined;
 if(asset){if(asset.kind!=='image')throw new Error('Raster rendering requires a still image.');const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const i=new Image();i.crossOrigin='anonymous';i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Could not load the source image.'));i.src=asset.url;});const scale=Math.min(1,2048/Math.max(img.naturalWidth,img.naturalHeight));canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);
 }else if(primary){const source=await renderNode(primary,p,cache,new Set(visiting));canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;canvas.getContext('2d')!.drawImage(source,0,0);}else throw new Error('Attach an image or connect an image input to preview this node.');
 if(!n.bypassed)for(const op of operationsFor(n).filter(o=>o.enabled)){
   const next=document.createElement('canvas');next.width=canvas.width;next.height=canvas.height;const ctx=next.getContext('2d')!;const v=op.values;
   if(op.kind==='grade')ctx.filter=`brightness(${v.brightness??100}%) contrast(${v.contrast??100}%) saturate(${v.saturation??100}%)`;
   if(op.kind==='transform'){ctx.translate(next.width/2,next.height/2);ctx.rotate(Number(v.rotation||0)*Math.PI/180);ctx.scale(Number(v.scale??100)/100*(v.flip?-1:1),Number(v.scale??100)/100);ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);}
   else if(op.kind==='mask'){ctx.beginPath();if(v.invert)ctx.rect(0,0,next.width,next.height);const factor=Number(v.size??80)/100;if(v.shape==='rectangle')ctx.rect(next.width*(1-factor)/2,next.height*(1-factor)/2,next.width*factor,next.height*factor);else ctx.ellipse(next.width/2,next.height/2,next.width*factor/2,next.height*factor/2,0,0,2*Math.PI);ctx.clip(v.invert?'evenodd':'nonzero');ctx.drawImage(canvas,0,0);}
   else if(op.kind==='mix'){ctx.drawImage(canvas,0,0);if(inputs[1]){const layer=await renderNode(inputs[1],p,cache,new Set(visiting));ctx.globalAlpha=Number(v.opacity??50)/100;ctx.globalCompositeOperation=(v.blend||'source-over') as GlobalCompositeOperation;ctx.drawImage(layer,0,0,next.width,next.height);}}
   else ctx.drawImage(canvas,0,0);canvas=next;
 }
 cache.set(n.id,canvas);return canvas;
}
