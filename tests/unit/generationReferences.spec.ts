import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { referenceKey, selectFirstFrame, videoReferenceProblem } from '../../lib/generationReferences';
import { getModel } from '../../lib/models';
import { getTask } from '../../lib/tasks';
import type { RefItem } from '../../lib/refs';
import type { Reference, VideoParams } from '../../lib/ark';
const nodeRequire = createRequire(path.resolve('package.json'));
function load<T>(file:string):T {
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};
  new Function('require','module','exports',code)((name:string)=>name==='./storage'?{usingBlob:()=>false,readUploadBytes:async()=>Buffer.from('unchanged original')}:
    name==='./engines'?{}:name.startsWith('.')?nodeRequire(path.resolve(path.dirname(file),name+'.ts')):nodeRequire(name),mod,mod.exports);
  return mod.exports as T;
}
const ref=(id:string,role:RefItem['role']='reference_image',origin:RefItem['origin']='upload')=>({id,role,origin,kind:'image',filename:id,mime:'image/png',url:`/api/media/${id}`,bytes:12} as RefItem);
const kling=getModel('fal-ai/kling-video/v3/standard');
const seedance=getModel('dreamina-seedance-2-5-260628');
test('first frame is an explicit identity and No first frame preserves all media as references',()=>{
  const original=[ref('same'),ref('same','reference_image','generation')];
  const selected=selectFirstFrame(original,'generation:same');
  expect(selected.map(r=>[referenceKey(r),r.role])).toEqual([['upload:same','reference_image'],['generation:same','first_frame']]);
  expect(selectFirstFrame(selected,null)).toEqual(original);
  expect(original.every(r=>r.role==='reference_image')).toBe(true);
  expect(()=>selectFirstFrame(original,'upload:missing')).toThrow('attached image');
});
test('ordinary references remain references and unsupported engines fail clearly',()=>{
  expect(videoReferenceProblem(seedance,[ref('one')])).toBeNull();
  expect(videoReferenceProblem(kling,[ref('one')])).toContain('Use as first frame');
  expect(videoReferenceProblem(seedance,[ref('one','first_frame'),ref('two')])).toContain('cannot be mixed');
  expect(videoReferenceProblem(kling,[ref('one','first_frame')])).toBeNull();
});
test('Grok is refused reference images at 1080p when the take is admitted, not after the reservation',()=>{
  const grok=getModel('grok-imagine-video-1.5');
  expect(videoReferenceProblem(grok,[ref('one')],'1080p')).toContain('up to 720p');
  expect(videoReferenceProblem(grok,[ref('one')],'720p')).toBeNull();
  expect(videoReferenceProblem(grok,[ref('one','first_frame')],'1080p')).toBeNull();
  expect(videoReferenceProblem(grok,[],'1080p')).toBeNull();
  expect(videoReferenceProblem(seedance,[ref('one')],'1080p')).toBeNull();
});
test('Kling sends a start image only for an explicit first frame and refuses ordinary references',async()=>{
  const {buildFalInput}=load<typeof import('../../lib/falVideo')>('lib/falVideo.ts');
  const image:Reference={id:'original',kind:'image',mime:'image/png',ext:'png',storedUrl:'/original.png',role:'first_frame'};
  const params:VideoParams={duration:5,ratio:'16:9',resolution:'1080p',watermark:false};
  const common={model:kling,task:getTask('generate'),prompt:'A quiet street',params,source:null};
  const first=await buildFalInput({...common,references:[image]});
  expect(first.endpoint).toMatch(/\/image-to-video$/);
  expect(first.input.start_image_url).toBe(`data:image/png;base64,${Buffer.from('unchanged original').toString('base64')}`);
  const none=await buildFalInput({...common,references:[]});
  expect(none.endpoint).toMatch(/\/text-to-video$/);expect(none.input).not.toHaveProperty('start_image_url');
  await expect(buildFalInput({...common,references:[{...image,role:'reference_image'}]})).rejects.toThrow('Use as first frame');
});
test('Seedance preserves the selected reference role in the provider payload',async()=>{
  const {buildRequestBody}=load<typeof import('../../lib/ark')>('lib/ark.ts');
  const image:Reference={id:'original',kind:'image',mime:'image/png',ext:'png',storedUrl:'/original.png',role:'reference_image'};
  const params:VideoParams={duration:5,ratio:'16:9',resolution:'720p',watermark:false};
  const reference=await buildRequestBody(seedance.id,'A street',params,[image]);
  const first=await buildRequestBody(seedance.id,'A street',params,[{...image,role:'first_frame'}]);
  expect(reference.content).toEqual(expect.arrayContaining([expect.objectContaining({role:'reference_image'})]));
  expect(first.content).toEqual(expect.arrayContaining([expect.objectContaining({role:'first_frame'})]));
});
/* Grok Imagine Video animates a first frame and takes no last frame: admission refuses one before
   anything is reserved, not the submit after it (which would drop it silently). */
test('Grok Imagine Video refuses a last frame before reserving',()=>{
  const grok=getModel('grok-imagine-video-1.5');
  const frame=(role:string)=>({kind:'image',role});
  expect(videoReferenceProblem(grok,[frame('first_frame'),frame('last_frame')],'720p')).toContain('no last frame');
  expect(videoReferenceProblem(grok,[frame('last_frame')])).not.toBeNull();
  expect(videoReferenceProblem(grok,[frame('first_frame')],'720p')).toBeNull();
  expect(videoReferenceProblem(kling,[ref('one','first_frame'),ref('two','last_frame')],'1080p')).toBeNull();
});
