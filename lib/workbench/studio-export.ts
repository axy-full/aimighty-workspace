import { makeFCPXML, makeXMEML } from './editorial-xml';
import {audioClips} from './audio';
import {zipSync,strToU8} from 'fflate';
import {Asset,Project,makeEDL,safeName,timecode,assetFilename,validateSequence} from './studio';
import {moleculrAssetDependencies,validateMoleculrBindings} from './moleculr-bindings';
import {originalAssetDownload} from './original-asset';
import {resolveReferenceAd} from './reference-ad';
import {withExportNames} from './export-names';

export type EditSettings={exposure:number;contrast:number;saturation:number;ratio:string;flip:boolean};
export const defaultEdits:EditSettings={exposure:100,contrast:100,saturation:100,ratio:'Original',flip:false};
export function downloadFile(blob:Blob,name:string){const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export async function renderImage(url:string,settings:EditSettings=defaultEdits):Promise<Blob>{
 const response=await fetch(url);if(!response.ok)throw new Error('The source image could not be loaded.');
 const bitmap=await createImageBitmap(await response.blob());
 try{let sw=bitmap.width,sh=bitmap.height;const ratio=settings.ratio==='Original'?sw/sh:settings.ratio.split(':').map(Number).reduce((a,b)=>a/b);if(!Number.isFinite(ratio)||ratio<=0)throw new Error('Invalid crop ratio');if(sw/sh>ratio)sw=sh*ratio;else sh=sw/ratio;
 const scale=Math.min(1,4096/Math.max(sw,sh));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image editing is not available in this browser.');ctx.filter=`brightness(${settings.exposure}%) contrast(${settings.contrast}%) saturate(${settings.saturation}%)`;if(settings.flip){ctx.translate(canvas.width,0);ctx.scale(-1,1);}ctx.drawImage(bitmap,(bitmap.width-sw)/2,(bitmap.height-sh)/2,sw,sh,0,0,canvas.width,canvas.height);return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image export failed.')),'image/png'));}finally{bitmap.close();}
}
function csv(value:unknown){let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
/** Include the selected sources and their original/reference lineage in the handoff. */
export function collectExportAssets(p:Project):Asset[]{
 validateMoleculrBindings(p);
 validateSequence(p);
 const assets=new Map(p.assets.map(asset=>[asset.id,asset]));
 const seen=new Set<string>(),result:Asset[]=[];
 const visit=(id:string)=>{
  if(seen.has(id))return;
  const asset=assets.get(id);
  if(!asset)throw new Error('A bound source or reference is missing ('+id+'). Repair its binding before exporting.');
  seen.add(id);result.push(asset);
  for(const reference of [...asset.refs,...(asset.parentId?[asset.parentId]:[])])visit(reference);
 };
 for(const assetId of [...(p.astraNative?.assetIds ?? []), ...(p.astraNative?.baseBlendAssetId ? [p.astraNative.baseBlendAssetId] : [])])visit(assetId);
 for(const object of p.astraBlender?.objects ?? [])if(object.assetId)visit(object.assetId);
 for(const shot of p.shots)visit(shot.assetId);
 for(const clip of audioClips(p))visit(clip.assetId);
 if(p.colorGrade?.lutAssetId)visit(p.colorGrade.lutAssetId);
 if(p.scriptSource)visit(p.scriptSource.assetId);
 for(const node of p.nodes){if(node.scriptScene?.sourceAssetId)visit(node.scriptScene.sourceAssetId);if(node.developmentSource?.sourceAssetId)visit(node.developmentSource.sourceAssetId);}
 for(const binding of moleculrAssetDependencies(p))visit(binding.assetId);
 return result;
}
const EXPORT_LIMIT=200*1024*1024;
const mediaTypes=new Set(['image/png','image/jpeg','image/webp','image/avif','image/gif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/ogg','application/pdf','text/plain']);

/** Build separately from download so source recovery and package integrity can be tested with mocks. */
export async function buildExportPackage(p:Project,fetchAsset:(url:string)=>Promise<Response>=(url)=>fetch(url)){
 const sources=collectExportAssets(p);
 const referenceVideoUrls=new Map(moleculrAssetDependencies(p).filter(binding=>binding.kind==='video').map(binding=>[binding.assetId,resolveReferenceAd(p,{assetId:binding.assetId})!.original.url]));
 const files:Record<string,Uint8Array>={};
 const sourceFiles:{assetId:string;file:string}[]=[];
 const exportAssets=new Map(p.assets.map(asset=>[asset.id,asset]));
 const links:{assetId:string;name:string;url:string}[]=[];
 let bytes=0;
 for(const original of sources){
  if(original.kind==='link'){links.push({assetId:original.id,name:original.name,url:original.url});continue;}
  const response=await fetchAsset(referenceVideoUrls.get(original.id) ?? originalAssetDownload(original)?.url ?? original.url);
  if(!response.ok)throw new Error('Cannot export '+original.name+'. Try opening the asset first.');
  const length=Number(response.headers.get('content-length')||0);
  if(length>EXPORT_LIMIT-bytes)throw new Error('This browser package is limited to 200 MB. Export the EDL and collect large sources separately.');
  const blob=await response.blob();bytes+=blob.size;
  if(bytes>EXPORT_LIMIT)throw new Error('This browser package is limited to 200 MB. Export the EDL and collect large sources separately.');
  const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(['image','video','audio'].includes(original.kind)&&(!blob.size||(mime&&mime!=='application/octet-stream'&&!mime.startsWith(original.kind+'/'))))throw new Error('The source for '+original.name+' did not return usable '+original.kind+' media.');
  // A protected media URL often has no extension; use its actual response type for relinking.
  const asset=mediaTypes.has(mime)?{...original,mime}:original;
  exportAssets.set(asset.id,asset);
  const filename='media/'+assetFilename(asset);
  if(files[filename])throw new Error('Two source filenames collide. Rename one of the assets before exporting.');
  files[filename]=new Uint8Array(await blob.arrayBuffer());
  sourceFiles.push({assetId:asset.id,file:filename});
 }
 const project={...p,assets:[...exportAssets.values()]};
 files['sequence.edl']=strToU8(makeEDL(project));
 files['sequence.fcpxml']=strToU8(makeFCPXML(project));
 files['sequence.xml']=strToU8(makeXMEML(project));
 let at=p.fps*3600;
 const rows=p.shots.map((shot,index)=>{
  const asset=exportAssets.get(shot.assetId)!;
  const row=[index+1,shot.name,assetFilename(asset),timecode(shot.sourceIn,p.fps),timecode(shot.sourceIn+shot.duration,p.fps),timecode(at,p.fps),timecode(at+shot.duration,p.fps),shot.duration,p.fps,shot.note];
  at+=shot.duration;return row.map(csv).join(',');
 });
 files['shotlist.csv']=strToU8(['event,shot,filename,source_in,source_out,record_in,record_out,duration_frames,fps,direction',...rows].join('\r\n'));
 files['production.json']=strToU8(JSON.stringify({format:'particl.editorial.v1',exportedAt:new Date().toISOString(),project,files:sourceFiles,links},null,2));
 if(links.length)files['reference-links.json']=strToU8(JSON.stringify(links,null,2));
 files['README.txt']=strToU8(`PARTICL / EDITORIAL HANDOFF

${p.name}
${p.fps} fps, non-drop frame. Record starts at 01:00:00:00.

sequence.edl: CMX3600, one video track, straight cuts only.
sequence.fcpxml: FCPXML 1.10 for Final Cut Pro and DaVinci Resolve — the cut plus the Sound lanes (dialogue, music, effects) at their positions, gain and mute.
sequence.xml: Final Cut Pro 7 XML (XMEML v4) for Premiere Pro — the same cut and lanes. Both point at media/ by relative path; relink to the unzipped folder if asked.
shotlist.csv: inclusive in / exclusive out timecodes and creative notes.
production.json: project snapshot, production record mappings, reference bindings, take lineage and crew plans.
media/: original bytes of assets used in the sequence, scratch audio, saved product profiles, brand logo, poster image layers (including hidden layers), current and prepared campaign reference videos, and their bound source/reference lineage.
reference-links.json (when present): saved website references. Web pages are not downloaded as media.

Import the EDL at the stated frame rate and relink using FROM CLIP NAME comments. Image sources are still-frame holds, not rendered video; configure still duration manually if your editor does not conform them. Some editors need WebP/GIF stills converted to PNG before relinking. Export a PNG from the Particl asset editor if needed. Video must already match the sequence frame rate and have zero-based source timecode; embedded timecodes and source frame rates have not been probed.

Audio source files and Sound mix clip positions, gain, pan, fades, mute and solo states are preserved in production.json. They are not placed by the EDL. Export the 48 kHz WAV mix from Edit & Sound for an aligned stereo handoff. Aspect ratio is a delivery instruction, not a reframe. Sequence color settings and the original .cube LUT are preserved in this package. Apply them manually in your NLE; the EDL does not carry grades. The Particl final movie bakes its sequence look. Saved image takes retain their own edits. Transitions, motion effects, a sound mix, synchronized audio, subtitles and a rendered master are not carried by this EDL. Fractional and drop-frame rates are unsupported.

The manifest preserves take lineage and saved versions. It is not an audit log of every edit. Relinking must be tested in your target NLE before a client delivery.
`);
 return files;
}
export async function exportPackage(p:Project){
 const files=await buildExportPackage(await withExportNames(p));
 downloadFile(new Blob([zipSync(files,{level:0}) as BlobPart],{type:'application/zip'}),safeName(p.name)+'_editorial.zip');
}
