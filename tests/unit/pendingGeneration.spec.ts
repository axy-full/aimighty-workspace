import { test, expect } from '@playwright/test';
import { pendingGenerationKey, readPendingGeneration, claimPendingGeneration, clearPendingGeneration } from '../../lib/workbench/pending-generation';
function storage() {
  const values = new Map<string,string>();
  return { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => {values.set(key,value)}, removeItem:(key:string) => {values.delete(key)} };
}
test('refresh and edited input reuse an uncertain generation instead of a second paid request', () => {
  const local = storage();
  const key = pendingGenerationKey('workspace:alice','draft','node');
  const first = {key:'original-request',body:JSON.stringify({model:'economy',prompt:'first'}),credits:3};
  claimPendingGeneration(local,key,first);
  expect(readPendingGeneration(local,key)).toEqual(first);
  expect(claimPendingGeneration(local,key,{key:'new-request',body:JSON.stringify({model:'premium',prompt:'edited'}),credits:100})).toEqual(first);
  clearPendingGeneration(local,key,'wrong-request');
  expect(readPendingGeneration(local,key)).toEqual(first);
  clearPendingGeneration(local,key,first.key);
  expect(readPendingGeneration(local,key)).toBeNull();
});
test('recovery is scoped to each collaborator, draft and node', () => {
  const keys = [pendingGenerationKey('workspace:alice','draft','node'),pendingGenerationKey('workspace:bob','draft','node'),pendingGenerationKey('workspace:alice','other','node'),pendingGenerationKey('workspace:alice','draft','other')];
  expect(new Set(keys).size).toBe(4);
});
test('unavailable or corrupt storage never silently creates a fresh paid request', () => {
  const local = storage(); local.setItem('key','{broken');
  expect(()=>claimPendingGeneration(local,'key',{key:'new',body:'{}',credits:2})).toThrow();
  expect(()=>claimPendingGeneration({...local,getItem:()=>null,setItem:()=>{throw new Error('storage blocked')}},'key',{key:'new',body:'{}',credits:2})).toThrow('storage blocked');
});
test('an uncertain node audio request retains its endpoint and original exact body', () => {
 const local=storage(),key=pendingGenerationKey('workspace:alice','draft','node');
 const audio={key:'original-audio',endpoint:'/api/audio' as const,body:JSON.stringify({task:'sound',text:'Rain',durationSeconds:5,projectId:'production',shotId:'shot',maxCredits:3}),credits:3};
 claimPendingGeneration(local,key,audio);
 expect(claimPendingGeneration(local,key,{key:'visual-attempt',body:'{}',credits:100,endpoint:'/api/generate'})).toEqual(audio);
 expect(readPendingGeneration(local,key)?.endpoint).toBe('/api/audio');
 local.setItem(key,JSON.stringify({...audio,endpoint:'https://invalid.example/paid'}));
 expect(()=>readPendingGeneration(local,key)).toThrow('cannot be read');
});
