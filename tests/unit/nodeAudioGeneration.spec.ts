import { test, expect } from '@playwright/test';
import { nodeAudioBody, validAudioQuote } from '../../lib/workbench/generation-audio';
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
