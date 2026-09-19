import { test, expect } from '@playwright/test';
import { newProject, type Asset } from '../../lib/workbench/studio';
import { projectSchema } from '../../lib/workbench/studio-schema';
import { soulIdentityAsset, soulReferenceAssets, identityCardState, identityCardLabels, type SoulIdentity } from '../../lib/workbench/soul-identity';

const portrait: Asset = { id:'portrait',name:'Mira portrait',kind:'image',category:'Character',url:'/api/uploads/portrait-original',uploadId:'portrait-original',description:'Portrait original',prompt:'Soft window light',status:'Draft',locked:false,version:1,refs:[] };
const identity: SoulIdentity = { id:'soul-local',projectId:null,name:'Mira',description:'Same character across shots',subjectType:'character',references:[{uploadId:'portrait-original'}],status:'ready',previewUrl:'/api/uploads/portrait-original',createdAt:1,updatedAt:1,creditsBilled:250,error:null };

test('Soul references include original uploads and generated stills once, excluding links, samples and movies', () => {
  const generated = {...portrait,id:'generated',uploadId:undefined,generationId:'still-render',url:'/api/media/still-render'};
  expect(soulReferenceAssets([
    portrait,{...portrait,id:'duplicate'},generated,{...portrait,id:'movie',kind:'video'},
    {...portrait,id:'sample',uploadId:undefined,url:'/campaign/character.webp'},
    {...portrait,id:'web',uploadId:undefined,url:'https://example.test/portrait.png'},
  ])).toEqual([portrait,generated]);
});

test('ready Soul binding retains downloadable originals and survives project persistence', () => {
  const project = {...newProject('Soul fixture'),assets:[portrait]};
  const attached = soulIdentityAsset(project,identity,'Character');
  expect(attached).toMatchObject({name:'Mira',kind:'image',category:'Character',soulIdentityId:'soul-local',uploadId:'portrait-original',url:'/api/uploads/portrait-original',refs:[]});
  expect(attached.generationId).toBeUndefined();
  const saved = projectSchema.parse({...project,assets:[...project.assets,attached]});
  expect(saved.assets.at(-1)?.soulIdentityId).toBe(identity.id);
  expect(saved.assets.at(-1)?.url).toBe(portrait.url);
});

test('replacing a generated character cover removes the stale generation reference and preserves its asset ID', () => {
  const existing = {...portrait,id:'character',uploadId:undefined,generationId:'old-generation',url:'/api/media/old-generation',version:3};
  const project = {...newProject('Soul fixture'),assets:[existing,portrait]};
  const attached = soulIdentityAsset(project,identity,'Character','character');
  expect(attached).toMatchObject({id:'character',name:existing.name,version:4,uploadId:'portrait-original',url:portrait.url,soulIdentityId:identity.id});
  expect(attached.generationId).toBeUndefined();
  const generatedIdentity = {...identity,references:[{genId:'generated-cover'}]};
  expect(soulIdentityAsset(project,generatedIdentity,'Element')).toMatchObject({generationId:'generated-cover',url:'/api/media/generated-cover',category:'Element'});
});

test('pending identities and locked or missing targets cannot change project bindings', () => {
  const project = {...newProject('Soul fixture'),assets:[{...portrait,locked:true}]};
  expect(() => soulIdentityAsset(project,{...identity,status:'training'},'Character')).toThrow('not ready');
  expect(() => soulIdentityAsset(project,identity,'Character',portrait.id)).toThrow('Unlock');
  expect(() => soulIdentityAsset(project,identity,'Character','missing')).toThrow('no longer');
  expect(() => soulIdentityAsset(project,{...identity,references:[]},'Character')).toThrow('no original');
});

test('Cast & Elements cards read identity state from the workspace list, never from the binding alone', () => {
  const list: SoulIdentity[] = [identity, {...identity,id:'soul-training',status:'training'}, {...identity,id:'soul-failed',status:'failed'}, {...identity,id:'soul-uncertain',status:'uncertain'}];
  expect(identityCardState({soulIdentityId:undefined},list)).toBe('none');
  expect(identityCardState({soulIdentityId:'soul-local'},list)).toBe('ready');
  expect(identityCardState({soulIdentityId:'soul-training'},list)).toBe('training');
  expect(identityCardState({soulIdentityId:'soul-failed'},list)).toBe('failed');
  expect(identityCardState({soulIdentityId:'soul-uncertain'},list)).toBe('failed');
  expect(identityCardState({soulIdentityId:'soul-local'},null)).toBe('unknown');
  expect(identityCardState({soulIdentityId:'soul-elsewhere'},list)).toBe('unknown');
  for (const label of Object.values(identityCardLabels)) expect(label).not.toMatch(/soul|higgsfield|fal\b/i);
});
