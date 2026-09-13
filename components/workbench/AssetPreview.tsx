'use client';
import { useState, type CSSProperties } from 'react';
import LazyMedia from '@/components/LazyMedia';
import type { Asset } from '@/lib/workbench/studio';
export function AssetPreview({asset,className='',style}:{asset:Asset;className?:string;style?:CSSProperties}){
  const [failed,setFailed]=useState('');
  const upload=asset.uploadId||asset.url.match(/^\/api\/uploads\/([^/?#]+)/)?.[1];
  const generated=asset.generationId||asset.url.match(/^\/api\/media\/([^/?#]+)/)?.[1];
  const preview=generated?`/api/workbench/preview/generation/${encodeURIComponent(generated)}`:upload?`/api/workbench/preview/upload/${encodeURIComponent(upload)}`:asset.url;
  if(asset.kind==='video')return <span className={className} style={style}><LazyMedia url={asset.url} kind="video" alt={asset.name} className="workbench-video-preview"/></span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={failed===preview?asset.url:preview} onError={()=>setFailed(preview)} alt={asset.name} style={style} draggable={false} loading="lazy" decoding="async"/>;
}
