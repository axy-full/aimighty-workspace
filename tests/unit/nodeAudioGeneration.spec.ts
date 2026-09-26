import { test, expect } from '@playwright/test';
import { audioTaskAvailable, nodeAudioBody, speechVoiceFor, speechVoicesFor, usableAudioTask, validAudioQuote } from '../../lib/workbench/generation-audio';
const common={text:'A quiet evening',seconds:12.5,instrumental:true,voiceId:'voice123',modelId:'speech-model'};
test('node sound, music and speech quote exactly the parameters later submitted',()=>{
 expect(nodeAudioBody({...common,task:'sound'})).toEqual({task:'sound',text:common.text,durationSeconds:12.5});
 expect(nodeAudioBody({...common,task:'music'})).toEqual({task:'music',text:common.text,lengthMs:12500,instrumental:true});
 expect(nodeAudioBody({...common,task:'speech'})).toEqual({task:'speech',text:common.text,voiceId:'voice123',modelId:'speech-model'});
});
test('invalid audio estimates cannot authorize a paid request',()=>{
 expect(validAudioQuote({estimatedCredits:12})).toBe(true);
 for(const value of [null,undefined,-1,0.5,Infinity,'12']) expect(validAudioQuote({estimatedCredits:value})).toBe(false);
});
/* Each speech model reads in its own vendor's voices: Grok Voice never gets an ElevenLabs voice, nor the reverse. */
const both={configured:true,vendors:{elevenlabs:true,xai:true},speechModels:[{id:'eleven_multilingual_v2',label:'Multilingual v2'},{id:'grok-tts',label:'Grok Voice'}],
  defaultSpeechModel:'eleven_multilingual_v2',voices:[{id:'21m00Tcm4TlvDq8ikWAM',name:'Rachel'}],grokVoices:[{id:'eve',name:'Eve'},{id:'ara',name:'Ara'}],voicesError:null};
test('a speech model lists its own vendor\'s voices, and a voice chosen for the other falls back to the first',()=>{
 expect(speechVoicesFor(both,'grok-tts').map(v=>v.id)).toEqual(['eve','ara']);
 expect(speechVoicesFor(both,'eleven_multilingual_v2').map(v=>v.id)).toEqual(['21m00Tcm4TlvDq8ikWAM']);
 expect(speechVoicesFor({...both,grokVoices:undefined},'grok-tts')).toEqual([]);
 expect(speechVoicesFor(null,'grok-tts')).toEqual([]);
 expect(speechVoiceFor(speechVoicesFor(both,'grok-tts'),'21m00Tcm4TlvDq8ikWAM')?.id).toBe('eve');
 expect(speechVoiceFor(speechVoicesFor(both,'grok-tts'),'ara')?.id).toBe('ara');
 expect(speechVoiceFor(speechVoicesFor(both,'eleven_multilingual_v2'),'eve')?.id).toBe('21m00Tcm4TlvDq8ikWAM');
 expect(speechVoiceFor([],'eve')).toBeNull();
});
test('a workspace on Grok Voice alone speaks, and sound and music stay ElevenLabs\'',()=>{
 const grokOnly={...both,vendors:{elevenlabs:false,xai:true},speechModels:[{id:'grok-tts',label:'Grok Voice'}],defaultSpeechModel:'grok-tts',voices:both.grokVoices};
 expect(['speech','sound','music','voiceChange','dub'].map(task=>audioTaskAvailable(grokOnly,task))).toEqual([true,false,false,false,false]);
 expect(['speech','sound','music','voiceChange','dub'].map(task=>audioTaskAvailable(both,task))).toEqual([true,true,true,true,true]);
 /* An older reply without vendors is ElevenLabs'. */
 expect(audioTaskAvailable({configured:true,speechModels:[]},'sound')).toBe(true);
 expect(audioTaskAvailable({...grokOnly,configured:false},'speech')).toBe(false);
 expect(usableAudioTask(grokOnly,'sound')).toBe('speech');
 expect(usableAudioTask(both,'music')).toBe('music');
 expect(usableAudioTask(null,'sound')).toBe('sound');
});
