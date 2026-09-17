'use client';

import { useState } from 'react';
import { Download, FileText, AudioLines, Film, Image as ImageIcon, X } from 'lucide-react';
import GenAssetLibrary, { type GenAssetLibraryProps } from '@/components/make/GenAssetLibrary';
import type { LibrarySource } from '@/lib/genLibrary';
import { ASSET_GROUPS } from '@/lib/genLibrary';
import type { Asset } from '@/lib/workbench/studio';
import { originalAssetDownload } from '@/lib/workbench/original-asset';
import { useSession } from '@/lib/session';
import genStyles from '@/components/make/gen.module.css';
import styles from './project-asset-library.module.css';

export type ProjectAssetLibraryProps = Omit<GenAssetLibraryProps,'search'|'workbenchProjectId'|'projectName'|'source'|'onSourceChange'> & {
  projectId: string;
  projectName: string;
  onClose?: () => void;
  /** Existing private source files retain their authenticated workbench URLs. */
  fallbackAssets?: Asset[];
  onUseProjectAsset?: (asset: Asset) => void;
  onEditProjectAsset?: (asset: Asset) => void;
};
export default function ProjectAssetLibrary(props: ProjectAssetLibraryProps) {
  const { requestScope } = useSession();
  return <ProjectLibrary key={`${requestScope}:${props.projectId}`} {...props}/>;
}
function ProjectLibrary({projectId,projectName,onClose,fallbackAssets=[],onUseProjectAsset,onEditProjectAsset,...props}: ProjectAssetLibraryProps) {
  const [search,setSearch] = useState(''), [source,setSource] = useState<LibrarySource>(props.initialSource ?? 'uploads');
  const legacy = fallbackAssets.filter(asset=>/^\/api\/workbench\/media\/[A-Za-z0-9_-]+(?:[?#]|$)/.test(asset.url)
    && (asset.generationId||asset.parentId||asset.category==='Shot'?'generations':'uploads')===source
    && (!search.trim()||`${asset.name} ${asset.description}`.toLowerCase().includes(search.trim().toLowerCase())));
  return <section className={`${genStyles.workspace} ${styles.panel}`} aria-label="Project asset library">
    <header className={styles.header}>
      <div><h2>Library</h2><p>{projectName} · Files and takes for this project</p></div>
      <label className={styles.search}>Search<input value={search} onChange={event=>setSearch(event.target.value)} maxLength={200} aria-label="Search project assets" placeholder="Find a file or take…"/></label>
      {onClose&&<button type="button" className={styles.close} aria-label="Close project library" onClick={onClose}><X size={18}/></button>}
    </header>
    <div className={styles.body}>
      <GenAssetLibrary {...props} workbenchProjectId={projectId} projectName={projectName} search={search} source={source} onSourceChange={setSource}/>
      {legacy.length>0&&<section aria-label="Private project originals" className={styles.legacy}>
        <h3>Private project originals</h3><p>Earlier files retained with this project. Downloads contain the stored original.</p>
        {ASSET_GROUPS.map(group=>{
          const assets=legacy.filter(asset=>asset.kind===group.kind);if(!assets.length)return null;
          return <section key={group.kind} aria-label={`Private ${group.label.toLowerCase()}`}><h4>{group.label}</h4><div className={genStyles.takeGrid}>
            {assets.map(asset=>{const download=originalAssetDownload(asset);return <article key={asset.id} className={styles.legacyCard}>
              <div className={styles.legacyMedia}>{asset.kind==='image'?<ImageIcon size={28}/>:asset.kind==='video'?<Film size={28}/>:asset.kind==='audio'?<AudioLines size={28}/>:<FileText size={28}/>}</div>
              <strong>{asset.name}</strong><div className={styles.legacyActions}>
                {onUseProjectAsset&&<button type="button" onClick={()=>onUseProjectAsset(asset)}>Use in project</button>}
                {onEditProjectAsset&&<button type="button" onClick={()=>onEditProjectAsset(asset)}>Open asset</button>}
                {download&&<a href={download.url} download={download.filename} aria-label={`Download ${asset.name}`}><Download size={16}/>Original</a>}
              </div>
            </article>;})}
          </div></section>;
        })}
      </section>}
    </div>
  </section>;
}
