'use client';
import {useEffect,useRef,useState,type CSSProperties} from 'react';

export function useAtomikSize(mobile:boolean,scope:string,initialHeight=80) {
  const [size,setSize]=useState({width:320,height:initialHeight});
  const [viewport,setViewport]=useState({width:1280,height:800});
  useEffect(()=>{const update=()=>setViewport({width:window.innerWidth,height:window.visualViewport?.height??window.innerHeight});update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);return()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);};},[]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the saved browser layout preference after mount.
  useEffect(()=>{try{const raw=JSON.parse(localStorage.getItem(scope+':atomik-size')??'null');if(raw&&Number.isFinite(raw.width)&&Number.isFinite(raw.height))setSize({width:Math.max(300,Math.min(800,raw.width)),height:Math.max(45,Math.min(96,raw.height))});}catch{/* Optional layout preference. */}},[scope]);
  function update(value:number){const next={...size,[mobile?'height':'width']:value};setSize(next);try{localStorage.setItem(scope+':atomik-size',JSON.stringify(next));}catch{/* Optional layout preference. */}}
  const min=mobile?45:300,max=mobile?96:Math.max(300,Math.min(800,viewport.width-(viewport.width>1000?440:24)));
  const value=Math.max(min,Math.min(max,mobile?size.height:size.width));
  return {value,min,max,update,mobile,viewportHeight:viewport.height,style:{'--atomik-width':`${mobile?320:value}px`,'--atomik-height':`${mobile?value:80}dvh`} as CSSProperties};
}
export function AtomikResizer({size}:{size:ReturnType<typeof useAtomikSize>}) {
  const drag=useRef<{position:number;value:number}|null>(null);
  return <div role="separator" tabIndex={0} aria-label="Resize Atomik panel" aria-orientation={size.mobile?'horizontal':'vertical'} aria-valuemin={size.min} aria-valuemax={size.max} aria-valuenow={Math.round(size.value)} aria-valuetext={Math.round(size.value)+(size.mobile?' percent height':' pixels wide')} className={'atomik-resizer '+(size.mobile?'horizontal':'vertical')}
    onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={position:size.mobile?e.clientY:e.clientX,value:size.value};e.currentTarget.setPointerCapture(e.pointerId);}}
    onPointerMove={e=>{if(!drag.current)return;const delta=drag.current.position-(size.mobile?e.clientY:e.clientX);size.update(Math.max(size.min,Math.min(size.max,drag.current.value+(size.mobile?delta/size.viewportHeight*100:delta))));}}
    onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
    onPointerCancel={()=>{drag.current=null;}}
    onDoubleClick={()=>size.update(size.mobile?80:320)}
    onKeyDown={e=>{let next=size.value;if(e.key==='Home')next=size.min;else if(e.key==='End')next=size.max;else if(['ArrowLeft','ArrowUp'].includes(e.key))next+=size.mobile?5:24;else if(['ArrowRight','ArrowDown'].includes(e.key))next-=size.mobile?5:24;else return;e.preventDefault();size.update(Math.max(size.min,Math.min(size.max,next)));}}><span/></div>;
}
