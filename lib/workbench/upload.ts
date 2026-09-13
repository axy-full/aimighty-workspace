'use client';
import {uploadFile} from '@/lib/uploadClient';
/** Reuse the established bounded chunk upload and server-side streaming assembly. */
export async function uploadWorkbench(file:File,onProgress?:(pct:number)=>void){
  return uploadFile(file, file.type.startsWith('image/')||file.type.startsWith('video/')?'reference':'chat', onProgress);
}
