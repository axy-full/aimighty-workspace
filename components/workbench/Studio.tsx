"use client";
import {draftRequest,writeDraft,reconcileDraftWrite,DraftRequestError,type DraftWrite} from "@/lib/workbench/draft-request";
import {AtomikResizer,useAtomikSize} from "./AtomikResizer";
import UploadRecovery from "@/components/UploadRecovery";

import Link from "next/link";
import Image from "next/image";
import {ActionMenu,ActionDropdown,type StudioAction} from "./ActionMenu";
import WorkspaceMenu, {type WorkbenchAccount} from "./WorkspaceMenu";
import { MobileStudioMenu } from "@/components/studio/StudioNavigation";
import {AtomikMark} from "@/components/AtomikMark";
import {clearPrivateLocal} from "@/lib/session";
import React, {
  useState,
  useLayoutEffect,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  X,
  Upload,
  Paperclip,
  Link2,
  PanelRightClose,
  PanelRightOpen,
  MousePointer2,
  Hand,
  Maximize2,
  Undo2,
  Redo2,
  LayoutGrid,
  Image as ImageIcon,
  Film,
  Clapperboard,
  Layers,
  Box,
  UserRound,
  NotebookPen,
  SlidersHorizontal,
  Download,
  Play,
  Pause,
  SkipBack,
  MoreHorizontal,
  Search,
  Copy,
  Pin,
  Globe2,
  Folder,
  FolderOpen,
  Scissors,
  Sparkles,
  Command,
  GitBranch,
  AudioLines,
  FileText,
  MoveUp,
  MoveDown,
  Share2,
  Loader2,
  Eye,
  Settings2,
  Scan,
  Info,
  ExternalLink,
  TriangleAlert,
  Trash2,
  Palette,
} from "lucide-react";
import { Button } from "@/components/workbench/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/workbench/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/workbench/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/workbench/ui/select";
import { Slider } from "@/components/workbench/ui/slider";
import { Checkbox } from "@/components/workbench/ui/checkbox";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/workbench/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/workbench/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/workbench/ui/tooltip";
import { Toaster } from "@/components/workbench/ui/sonner";
import { toast } from "sonner";
import {
  Project,
  Asset,
  CanvasNode,
  Shot,
  Plan,
  Stage,
  STAGES,
  seedProject,
  newProject,
  uid,
  timecode,
  safeName,
  makeEDL,
} from "@/lib/workbench/studio";
import {
  exportPackage,
  downloadFile,
  renderImage,
  EditSettings,
  defaultEdits,
} from "@/lib/workbench/studio-export";
import {GenerationDialog,studioRequest,StudioRequestError,type GenerationTarget} from './GenerationDialog';
import {SoulIdentityPanel} from './SoulIdentityPanel';
import {soulIdentityAsset} from '@/lib/workbench/soul-identity';
import {AtomikRunDialog,type AtomikRunTarget} from './AtomikRunDialog';
import {MarketingStudioPanel} from './MarketingStudioPanel';
import {SuiteSwitcher,RoomRail,SuiteDock} from '@/components/suites/SuiteNavigation';
import {MoleculrWorkspace} from '@/components/suites/MoleculrWorkspace';
import {EMPTY_MOLECULR,moleculrNode,moleculrPrompt,moleculrReferences} from '@/lib/workbench/moleculr';
import {PAGES} from '@/lib/suites';
import {bindMoleculrReferences} from '@/lib/workbench/moleculr-graph';
import {generationReferenceIds} from '@/lib/workbench/node-graph';
import marketingStyles from './MarketingStudioPanel.module.css';
import {isMarketingPlan,type MarketingTask} from '@/lib/workbench/marketing-studio';
import {useProductionJobs} from './use-production-jobs';
import {ModelPicker,EffortPicker,thinkingModelName,effortLabel} from '@/components/atomik/ModelPicker';
import {uploadWorkbench} from '@/lib/workbench/upload';
import {AssetPreview} from './AssetPreview';
import {SoundMix} from './SoundMix';
import {AssetBins,AssetBinPicker} from './AssetBins';
import {EditVersions} from './EditVersions';
import {applyEdit,type EditVersion} from '@/lib/workbench/editorial';
import { SequenceColor } from "./SequenceColor";
import colorStyles from "./SequenceColor.module.css";
import { defaultColorGrade, colorLutAsset } from "@/lib/workbench/color";
import {TimelinePreview} from './TimelinePreview';
import {audioClips} from '@/lib/workbench/audio';
import {createMovieHandoff} from '@/lib/workbench/movie-handoff';
import DesignReview from "./design-review";
import { CrewPanel, StoryboardPanel } from "./production-crew";
import { ScriptPanel } from './ScriptPanel';
import { DevelopmentPanel } from './DevelopmentPanel';
import { applyDevelopment } from '@/lib/workbench/development-apply';
import { developmentSourceHash } from '@/lib/workbench/development-client';
import { sourceCanonical, type DevelopmentJob } from '@/lib/workbench/development-types';
import { originalAssetDownload } from '@/lib/workbench/original-asset';
import { buildScreenplayNodes, sceneCoverageRequest } from '@/lib/workbench/screenplay-nodes';
import type {ScreenplayImport} from '@/lib/workbench/screenplay';
import { CREW, ScriptScene } from "@/lib/workbench/crew";
import ProductionGraph from "./production-graph";
import {
  MobileNavigation,
  MobilePanel,
  useMobileLayout,
  useMobileViewport,
} from "./mobile-ui";

const icons = [
  NotebookPen,
  FileText,
  Palette,
  UserRound,
  Box,
  GitBranch,
  Clapperboard,
  Layers,
  Scissors,
  Download,
];
const nodeIcons = {
  brief: NotebookPen,
  moodboard: Palette,
  character: UserRound,
  element: Box,
  scene: Clapperboard,
  note: NotebookPen,
};
const nodeLabels = {
  brief: "CREATIVE BRIEF",
  moodboard: "MOODBOARD",
  character: "CHARACTER",
  element: "ELEMENT",
  scene: "SCENE 01",
  note: "DIRECTION",
};
function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={"icon-btn " + (active ? "active" : "")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
function Choice({
  value,
  onChange,
  options,
  label,
  className = "",
}: {
  value: string;
  onChange: (s: string) => void;
  options: string[];
  label: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={"choice " + className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="ps select-menu">
        {options.map((v) => (
          <SelectItem value={v} key={v}>
            {v}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="30 68 140 64"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="38.7" cy="120.8" r="1.8" />
      <circle cx="50.9" cy="100.5" r="2.8" />
      <circle cx="69.8" cy="86.3" r="4" />
      <circle cx="92.7" cy="80.1" r="5.5" />
      <circle cx="116.2" cy="83" r="7.2" />
      <circle cx="136.9" cy="94.5" r="9.2" />
      <circle cx="151.7" cy="112.9" r="12" />
    </svg>
  );
}
function AtomMark() {
  return <AtomikMark size={20} className="atom-mark" />;
}
function Media({
  asset,
  className = "",
  style,
}: {
  asset?: Asset;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (!asset)
    return (
      <div className={"media-empty " + className}>
        <ImageIcon />
        <span>Add a reference</span>
      </div>
    );
  if (asset.kind === "image" || asset.kind === "video")
    return <AssetPreview asset={asset} className={className} style={style}/>;
  return (
    <div className={"media-empty " + className}>
      {asset.kind === "audio" ? (
        <AudioLines />
      ) : asset.kind === "link" ? (
        <Globe2 />
      ) : (
        <FileText />
      )}
      <span>{asset.name}</span>
    </div>
  );
}
function statusClass(a: Asset) {
  return a.status === "Selected"
    ? "selected"
    : a.status === "Continuity note"
      ? "review"
      : "draft";
}

export default function Studio({
  apiBase = "/api",
  sourceMode = false,
  signedIn = false,
  storageKey = "particl-visitor",
  initialAccount = null,
}: {
  apiBase?: string;
  sourceMode?: boolean;
  signedIn?: boolean;
  storageKey?: string;
  initialAccount?: WorkbenchAccount|null;
}) {
  const [generationTarget,setGenerationTarget]=useState<(GenerationTarget & {draftId:string})|null>(null);
  const [atomikTarget,setAtomikTarget]=useState<(AtomikRunTarget & {draftId:string})|null>(null);
  const [productions,setProductions]=useState<{id:string;name:string}[]>([]);
  const mobile = useMobileLayout();
  useMobileViewport();
  const [sequenceExpanded, setSequenceExpanded] = useState(false);
  const [editInspector,setEditInspector] = useState<"shot"|"color"|"versions"|"sound">("shot");
  const [p, setP] = useState<Project>(seedProject);
  const [stage, storeStage] = useState<Stage>("canvas");
  const [suite,setSuite]=useState<'particl'|'moleculr'>('particl');
  const [moleculrPage,storeMoleculrPage]=useState('product');
  function setMoleculrPage(page:string){
    if(!PAGES.moleculr.some(item=>item.id===page))return;
    setSuite('moleculr');storeMoleculrPage(page);setHome(false);
    const url=new URL(window.location.href);url.searchParams.set('suite','moleculr');url.searchParams.set('page',page);url.searchParams.delete('stage');url.searchParams.delete('view');window.history.replaceState(window.history.state,'',url);
  }
  const [mobileWorkflowOpen,setMobileWorkflowOpen] = useState(false);
  const [homeOverride, setHome] = useState<boolean|null>(null);
  const home=homeOverride??mobile;
  function setStage(value: Stage) {
    if(sourceMode&&typeof window!=='undefined'){const url=new URL(window.location.href);url.searchParams.set('stage',value);url.searchParams.delete('suite');url.searchParams.delete('page');url.searchParams.delete('view');window.history.replaceState(window.history.state,'',url);}
    setSuite('particl');
    setHome(false);
    storeStage(value);
    setSequenceExpanded(false);
    if (mobile) setAtomOpen(false);
  }
  const [scope, setScope] = useState("My space");
  const [welcomeChoice,setWelcomeChoice]=useState(false);
  const [samplePreview,setSamplePreview]=useState(false);
  const [atomOpen, setAtomOpen] = useState(false);
  const atomikSize=useAtomikSize(mobile,storageKey);
  const uncertainSave=useRef<DraftWrite|null>(null);
  const retryableSave=useRef(false);
  const autoSaveRetries=useRef(0);
  const failedLoad=useRef<{id:string;retryable:boolean;attempts:number}|null>(null);
  const [atomTab, setAtomTab] = useState("genie");
  const [marketingDrafts,setMarketingDrafts]=useState<Record<string,{task:MarketingTask;instructions:string}>>({});
  const marketingDraftKey=storageKey+':'+p.id;
  const marketingDraft=marketingDrafts[marketingDraftKey]??{task:'kit' as MarketingTask,instructions:''};
  const [model, setModel] = useState("auto");
  const [effort, setEffort] = useState("auto");
  const [depth, setDepth] = useState("Quick");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadingRef=useRef(0);
  const [contextIds, setContextIds] = useState<string[]>([
    "character",
    "environment",
  ]);
  const [selectedNode, setSelectedNode] = useState<string | null>("scene");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [soulTarget, setSoulTarget] = useState<{draftId:string;subjectType:'character'|'element';assetId?:string}|null>(null);
  const [dialog, setDialog] = useState<
    | "project"
    | "node"
    | "reference"
    | "shortcuts"
    | "review"
    | "connections"
    | null
  >(null);
  const [newName, setNewName] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [nodeKind, setNodeKind] = useState("Scene");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [assetFilter, setAssetFilter] = useState("All assets");
  const [binSelection,setBinSelection]=useState({projectId:"",id:""});
  const selectedBin=binSelection.projectId===p.id?binSelection.id:"";
  const [binAssetId,setBinAssetId]=useState<string|null>(null);
  const [saveState, setSaveState] = useState(signedIn?"Loading":"Sample project");
  const [saveError, setSaveError] = useState("");
  const [bibleConflict,setBibleConflict]=useState<{draftId:string;version:number;message:string}|null>(null);
  const [ready, setReady] = useState(false);
  const [initializedScope, setInitializedScope] = useState<string|null>(null);
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);
  const [transitioning,setTransitioning]=useState(false);
  const transitioningRef=useRef(false);
  const readyRef=useRef(false);
  const publishingRef=useRef(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [zoom, setZoom] = useState(0.78);
  const [pan, setPan] = useState({ x: 16, y: 0 });
  const [canvasTool, setCanvasTool] = useState("select");
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [shotId, setShotId] = useState("s01");
  const [exporting, setExporting] = useState(false);
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadCategory = useRef("Reference");
  const canvasRef = useRef<HTMLDivElement>(null);
  const atomMessages = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pRef = useRef(p);
  useLayoutEffect(()=>{pRef.current=p},[p]);
  const revisions = useRef(new Map<string,number>());
  const savedSnapshots=useRef(new Map<string,string>());
  const savingWrites=useRef(0);
  const saveChain = useRef(Promise.resolve());
  const pendingSave = useRef<Project | null>(null);
  const failedSave = useRef(false);
  const history = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const loadToken = useRef(0);
  const drag = useRef<{
    kind: "pan" | "node";
    id?: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    initial: Project;
  } | null>(null);
  const totalFrames = p.shots.reduce((n, s) => n + s.duration, 0);
  const activeShot = p.shots.find((s) => s.id === shotId) || p.shots[0];
  const selected = p.assets.find((a) => a.id === selectedAsset);
  const assetsById = useMemo(
    () =>
      new Map(
        (scope === "Shared production"
          ? p.sharedAssets || p.assets
          : p.assets
        ).map((a) => [a.id, a]),
      ),
    [p.assets, p.sharedAssets, scope],
  );
  const currentShot = (() => {
    let at = 0;
    for (const s of p.shots) {
      if (frame < at + s.duration) return { shot: s, start: at };
      at += s.duration;
    }
    return {
      shot: p.shots[p.shots.length - 1],
      start: Math.max(0, at - (p.shots.at(-1)?.duration || 0)),
    };
  })();
  const change = useCallback(
    (fn: (prev: Project) => Project, remember = true) => {
      if(transitioningRef.current)return;
      const prev=pRef.current;
      const next=fn(prev);
      if(next===prev)return;
      if(remember){history.current.push(structuredClone(prev));if(history.current.length>40)history.current.shift();future.current=[];}
      pRef.current=next;
      setP(next);
    },
    [],
  );
  const undo = useCallback(() => {
    if(transitioningRef.current)return;
    const last=history.current.pop();
    if(last&&last.id===pRef.current.id){future.current.push(pRef.current);pRef.current=last;setP(last);toast("Change undone");}
  }, []);
  const redo = useCallback(() => {
    if(transitioningRef.current)return;
    const next=future.current.pop();
    if(next&&next.id===pRef.current.id){history.current.push(pRef.current);pRef.current=next;setP(next);}
  }, []);
  const jobs=useProductionJobs(p,ready&&signedIn&&!transitioning,change);
  const generatingNodeId=selectedNode&&jobs.mediaJobs.some(job=>['held','queued','running'].includes(job.status)&&job.shotId===p.shotMappings?.[selectedNode])?selectedNode:null;
  const flushSave = useCallback(() => {
    const captured=uncertainSave.current?.project??pendingSave.current;
    if(!captured)return saveChain.current;
    if(pendingSave.current===captured)pendingSave.current=null;
    savingWrites.current++;
    saveChain.current=saveChain.current.then(async()=>{
      if(failedSave.current)return;
      const snapshot=JSON.stringify(captured);
      if(savedSnapshots.current.get(captured.id)===snapshot)return;
      try{
        const uncertain=uncertainSave.current;
        const write=uncertain??{project:captured,revision:revisions.current.get(captured.id)??0};
        const reconciled=uncertain?await reconcileDraftWrite(apiBase,storageKey,uncertain):null;
        uncertainSave.current=write;
        const data=reconciled??await writeDraft(apiBase,storageKey,write);
        uncertainSave.current=null;retryableSave.current=false;autoSaveRetries.current=0;
        revisions.current.set(captured.id,data.revision);
        const stored={...captured,productionProjectId:data.productionProjectId,shotMappings:data.shotMappings};
        savedSnapshots.current.set(captured.id,JSON.stringify(stored));
        // A completion belongs only to its own draft. Merge server identities
        // into current edits without replacing what changed during the request.
        if(pRef.current.id===captured.id){
          const current=pRef.current;
          const next={...current,productionProjectId:data.productionProjectId,shotMappings:data.shotMappings};
          if(JSON.stringify(current)!==JSON.stringify(next)){pRef.current=next;setP(next);}
          setSaveState(savedSnapshots.current.get(captured.id)===JSON.stringify(next)?"Saved":"Saving");
          setSaveError("");
        }
        setProjects(prev=>[{id:captured.id,name:captured.name},...prev.filter(item=>item.id!==captured.id)]);
      }catch(error){
        failedSave.current=true;
        retryableSave.current=error instanceof DraftRequestError&&error.retryable;
        if(error instanceof DraftRequestError&&!error.uncertain)uncertainSave.current=null;
        if(pRef.current.id===captured.id){setSaveState(error instanceof DraftRequestError&&error.uncertain?"Save unconfirmed":"Not saved");setSaveError(error instanceof Error?error.message:"Save failed. Your current work is preserved.");}
      }
    }).finally(()=>{savingWrites.current--;});
    return saveChain.current;
  },[apiBase,storageKey]);
  const drainSaves=useCallback(async(expectedId:string)=>{
    while(pRef.current.id===expectedId&&!failedSave.current){
      const latest=pRef.current;
      if(savedSnapshots.current.get(expectedId)!==JSON.stringify(latest))pendingSave.current=latest;
      await flushSave();
      if(pRef.current.id!==expectedId||failedSave.current)return false;
      if(savedSnapshots.current.get(expectedId)===JSON.stringify(pRef.current)&&!pendingSave.current)return true;
    }
    return false;
  },[flushSave]);
  async function ensureSaved(expectedId=pRef.current.id,refreshIdentities=false){
    if(!readyRef.current&&signedIn){toast.error("Create a project to save your work and generate takes.");return false;}
    if(!signedIn){toast.error("Sign in to save your project.");return false;}
    if(transitioningRef.current||pRef.current.id!==expectedId)return false;
    if(refreshIdentities)savedSnapshots.current.delete(expectedId);
    return drainSaves(expectedId);
  }
  async function saveNamedEdit(label:string,id:string):Promise<EditVersion>{
    const draftId=pRef.current.id;
    const endpoint=apiBase+'/edit-versions?draftId='+encodeURIComponent(draftId)+'&id='+encodeURIComponent(id);
    const prior=await fetch(endpoint,{headers:{'X-Workbench-Scope':storageKey},cache:'no-store'});
    if(prior.ok){const found=await prior.json();if(found.version.label!==label.trim())throw Error('This request names another edit version.');return found.version;}
    if(prior.status!==404)throw Error((await prior.json()).error||'Could not check the saved version.');
    if(!await ensureSaved(draftId))throw Error('Save the current project before naming this cut.');
    const payload={draftId,id,label,revision:revisions.current.get(draftId)};
    try {
      const response=await fetch(apiBase+'/edit-versions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':storageKey},body:JSON.stringify(payload)});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Could not save edit version.');return value.version;
    }catch(error){
      const check=await fetch(endpoint,{headers:{'X-Workbench-Scope':storageKey},cache:'no-store'}).catch(()=>null);
      if(check?.ok){const found=(await check.json()).version;if(found.label===label.trim()&&found.revision===payload.revision)return found;}
      throw error;
    }
  }
  async function restoreNamedEdit(id:string){
    const draftId=pRef.current.id;
    if(!await ensureSaved(draftId))throw Error('Save your current work before restoring a cut.');
    const original=JSON.stringify(pRef.current);
    const response=await fetch(apiBase+'/edit-versions?draftId='+encodeURIComponent(draftId)+'&id='+encodeURIComponent(id),{headers:{'X-Workbench-Scope':storageKey},cache:'no-store'});
    const value=await response.json();if(!response.ok)throw Error(value.error||'Could not read edit version.');
    if(pRef.current.id!==draftId||JSON.stringify(pRef.current)!==original)throw Error('The edit changed while loading this version. Your current work was kept.');
    const restored=applyEdit(pRef.current,value.edit);
    if(pRef.current.shots.length)await saveNamedEdit(('Before restoring '+value.version.label).slice(0,100),crypto.randomUUID());
    if(pRef.current.id!==draftId||JSON.stringify(pRef.current)!==original)throw Error('The edit changed while retaining its backup. Your current work was kept.');
    change(()=>restored);setPlaying(false);setFrame(0);setShotId(restored.shots[0]?.id??'');
  }
  const beginTransition=useCallback(async()=>{
    if(uploadingRef.current){toast.error('Wait for your uploads to finish before switching projects.');return null;}
    if(publishingRef.current){toast.error('Wait for the shared Bible to finish publishing before switching projects.');return null;}
    const token=++loadToken.current;
    const from=pRef.current.id,wasReady=readyRef.current;
    transitioningRef.current=true;setTransitioning(true);
    setGenerationTarget(null);setAtomikTarget(null);setSoulTarget(null);setSelectedAsset(null);setPlaying(false);
    if(wasReady&&signedIn)await drainSaves(from);else await flushSave();
    if(token!==loadToken.current)return null;
    if(failedSave.current){
      transitioningRef.current=false;setTransitioning(false);
      toast.error("Download your current work before switching. Unsaved changes have been kept on screen.");
      return null;
    }
    readyRef.current=false;setReady(false);setSaveState("Loading");setSaveError("");
    return {token,from,wasReady};
  },[drainSaves,flushSave,signedIn]);
  const adoptProject=useCallback((next:Project,version:number,saved:boolean,persisted=next)=>{
    revisions.current.set(next.id,version);
    if(saved)savedSnapshots.current.set(next.id,JSON.stringify(persisted));else savedSnapshots.current.delete(next.id);
    pendingSave.current=null;failedSave.current=false;uncertainSave.current=null;retryableSave.current=false;autoSaveRetries.current=0;
    setBibleConflict(null);
    history.current=[];future.current=[];
    pRef.current=next;setP(next);readyRef.current=true;setReady(true);
    setContextIds(next.assets.filter(asset=>asset.locked||asset.category==='Character').map(asset=>asset.id));
    setSelectedNode(next.nodes[0]?.id??null);setSelectedAsset(null);setFrame(0);
    setSaveState(saved&&JSON.stringify(next)===JSON.stringify(persisted)?'Saved':'Saving');setSaveError('');
    if(sourceMode){const url=new URL(window.location.href);url.searchParams.set('project',next.id);window.history.replaceState(window.history.state,'',url);}
    try{localStorage.setItem(storageKey,next.id);}catch{/* Server persistence remains available when browser storage is disabled. */}
  },[storageKey,sourceMode]);
  const endTransition=useCallback((token:number)=>{
    if(token===loadToken.current){transitioningRef.current=false;setTransitioning(false);}
  },[]);
  const loadProject = useCallback(async(id:string)=>{
    const transition=await beginTransition();if(!transition)return;
    try{
      const data=await draftRequest<{revision:number;project?:Project;projects?:{id:string;name:string}[];productions?:{id:string;name:string}[];shared?:{assets:Asset[];nodes:CanvasNode[];version:number}}>(apiBase+"/projects?id="+encodeURIComponent(id),storageKey);
      if(transition.token!==loadToken.current)return;
      // Recheck the outgoing draft before accepting the next server response.
      if(transition.wasReady&&signedIn&&!(await drainSaves(transition.from)))throw new Error('Your latest changes could not be saved. The current project remains open.');
      if(transition.token!==loadToken.current)return;
      const persisted=data.project;
      if(!persisted){
        failedLoad.current=null;
        setProjects(data.projects??[]);setProductions(data.productions??[]);setWelcomeChoice(true);setSamplePreview(false);setHome(true);readyRef.current=false;setReady(false);setSaveState('Choose a project');return;
      }
      failedLoad.current=null;
      setWelcomeChoice(false);setSamplePreview(false);
      const next={...persisted};
      if(data.shared){next.sharedAssets=data.shared.assets;next.sharedNodes=data.shared.nodes;next.bibleVersion=data.shared.version;next.sharedAssetIds=data.shared.assets.map(a=>a.id);next.sharedNodeIds=data.shared.nodes.map(n=>n.id);}
      adoptProject(next,data.revision,Boolean(persisted),persisted??next);
      setProductions(data.productions??[]);setProjects(data.projects??[]);
    }catch(error){
      if(transition.token!==loadToken.current)return;
      failedLoad.current={id,retryable:error instanceof DraftRequestError&&error.retryable,attempts:failedLoad.current?.id===id?failedLoad.current.attempts:0};
      readyRef.current=transition.wasReady;setReady(transition.wasReady);setSaveState(transition.wasReady?'Project kept open':'Could not connect');setSaveError(error instanceof Error?error.message:'Unable to load your work.');
    }finally{endTransition(transition.token);}
  },[apiBase,beginTransition,drainSaves,adoptProject,endTransition,signedIn,storageKey]);
  useEffect(() => {
    // The shared async loader hydrates from the server after flushing any pending write.
    let last='dune-studies';
    try{last=new URLSearchParams(window.location.search).get('project')||localStorage.getItem(storageKey)||last;}catch{/* Hydrate the default draft when local storage is disabled. */}
    const params=new URLSearchParams(window.location.search);
    const requestedStage=params.get('stage');
    if(params.get('suite')==='moleculr'){
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the suite from the initial browser route alongside the existing stage state.
      setSuite('moleculr');storeMoleculrPage(PAGES.moleculr.find(item=>item.id===params.get('page'))?.id??'product');setHome(false);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial route state is read once from the browser URL.
    if(STAGES.some(s=>s.id===requestedStage)){storeStage(requestedStage as Stage);setHome(false);}
    else if(params.get('view')==='workspace')setHome(true);
    if(['open','marketing'].includes(params.get('atomik')??''))setAtomOpen(true);
    if(params.get('atomik')==='marketing')setAtomTab('marketing');
    if(signedIn&&params.get('new')==='1'){setDialog('project');const url=new URL(window.location.href);url.searchParams.delete('new');window.history.replaceState(window.history.state,'',url);}
    if(!signedIn)return;
    let active=true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the private draft from the server on mount.
    void loadProject(last).finally(()=>{if(active)setInitializedScope(storageKey);});
    return()=>{active=false;};
  }, [loadProject,signedIn,storageKey]);
  useEffect(() => {
    if (!ready||!signedIn||transitioning) return;
    if(savedSnapshots.current.get(p.id)===JSON.stringify(p))return;
    pendingSave.current = p;
    setSaveState(failedSave.current ? "Not saved" : "Saving");
    const timer = setTimeout(() => void flushSave(), 650);
    return () => clearTimeout(timer);
  }, [p, ready, signedIn, transitioning, flushSave]);
  useEffect(()=>{
    if(!saveError||!retryableSave.current||!signedIn)return;
    const reconnect=()=>{if(!failedSave.current||!retryableSave.current||!navigator.onLine)return;failedSave.current=false;pendingSave.current=pRef.current;setSaveState('Reconnecting');setSaveError('');void flushSave();};
    const timer=autoSaveRetries.current<2?setTimeout(()=>{autoSaveRetries.current++;reconnect();},2000*(autoSaveRetries.current+1)):undefined;
    window.addEventListener('online',reconnect);
    return()=>{clearTimeout(timer);window.removeEventListener('online',reconnect);};
  },[saveError,flushSave,signedIn]);
  useEffect(()=>{
    if(!saveError||ready||failedSave.current||!failedLoad.current?.retryable)return;
    const reconnect=()=>{const failure=failedLoad.current;if(!failure||!failure.retryable||!navigator.onLine||readyRef.current||transitioningRef.current)return;failure.attempts++;void loadProject(failure.id);};
    const timer=failedLoad.current.attempts<2?setTimeout(reconnect,2500):undefined;
    window.addEventListener('online',reconnect);
    return()=>{clearTimeout(timer);window.removeEventListener('online',reconnect);};
  },[saveError,ready,loadProject]);
  useEffect(() => {
    const cb = (e: BeforeUnloadEvent) => {
      if (pendingSave.current || failedSave.current || savingWrites.current>0 || (signedIn&&readyRef.current&&savedSnapshots.current.get(pRef.current.id)!==JSON.stringify(pRef.current))) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", cb);
    return () => window.removeEventListener("beforeunload", cb);
  }, [signedIn]);
  useEffect(() => {
    const cb = (e: KeyboardEvent) => {
      const editing = (e.target as HTMLElement)?.matches(
        'input,textarea,[contenteditable="true"]',
      );
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        setAtomOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !editing) {
        e.preventDefault();
        if(!(stage==='canvas'&&scope==='Shared production')){e.shiftKey ? redo() : undo();}
      }
      if (e.key === "?" && !editing) setDialog("shortcuts");
      if (e.code === "Space" && !editing && !(e.target as HTMLElement)?.closest('button,a,select,[role="slider"]') && stage === "edit") {
        e.preventDefault();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener("keydown", cb);
    return () => window.removeEventListener("keydown", cb);
  }, [stage, scope, undo, redo]);
  useEffect(() => {
    if (!playing || !totalFrames) return;
    const start = performance.now(),
      initial = frame;
    let raf = 0;
    const tick = (t: number) => {
      const f = initial + Math.floor(((t - start) / 1000) * p.fps);
      if (f >= totalFrames) {
        setFrame(totalFrames - 1);
        setPlaying(false);
        return;
      }
      setFrame(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalFrames, p.fps]);
  useEffect(() => {
    if (atomMessages.current && ['genie','runs'].includes(atomTab))
      atomMessages.current.scrollTop = atomMessages.current.scrollHeight;
  }, [p.plans.length, busy, atomTab]);
  useEffect(() => {
    const ctx = (
      document as Document & {
        modelContext?: {
          registerTool: (tool: unknown, opts?: unknown) => Promise<void>;
        };
      }
    ).modelContext;
    if (!ctx?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (
      name: string,
      description: string,
      schema: object,
      readOnly: boolean,
      execute: (input: unknown) => unknown,
    ) => {
      Promise.resolve(
        ctx.registerTool(
          {
            name,
            description,
            inputSchema: schema,
            annotations: { readOnlyHint: readOnly },
            execute,
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    };
    register(
      "read_production",
      "Read the currently visible project, nodes and sequence.",
      { type: "object", properties: {}, additionalProperties: false },
      true,
      () => ({
        id: pRef.current.id,
        name: pRef.current.name,
        nodes: pRef.current.nodes,
        shots: pRef.current.shots,
      }),
    );
    register(
      "navigate_production_stage",
      "Open one of the production stages.",
      {
        type: "object",
        properties: {
          stage: { type: "string", enum: STAGES.map((s) => s.id) },
        },
        required: ["stage"],
        additionalProperties: false,
      },
      false,
      (input) => {
        const s = (input as { stage: string })?.stage;
        if (!STAGES.some((i) => i.id === s))
          throw new Error("Unknown production stage");
        setStage(s as Stage);
        return { stage: s };
      },
    );
    return () => lifecycle.abort();
  }, []);
  function fitCanvas() {
    const w = canvasRef.current?.clientWidth || 900;
    const h = canvasRef.current?.clientHeight || 600;
    const nodes = pRef.current.nodes;
    if (!nodes.length) {
      setZoom(0.78);
      setPan({ x: 20, y: 20 });
      return;
    }
    const right = Math.max(...nodes.map((n) => n.x + n.width)) + 50,
      bottom =
        Math.max(...nodes.map((n) => n.y + (n.type === "note" ? 240 : 250))) +
        40;
    setZoom(Math.min(1.1, Math.max(0.35, Math.min(w / right, h / bottom))));
    setPan({ x: 10, y: 10 });
  }
  function setField(field: keyof Project, value: unknown) {
    change((old) => ({ ...old, [field]: value }));
  }
  function assetActions(a: Asset): StudioAction[] {
    return [
      {label: 'Open asset', run: () => setSelectedAsset(a.id)},
      {label: 'Add to canvas', run: () => addNode(a.category === 'Character' ? 'character' : a.category === 'Environment' || a.category === 'Element' ? 'element' : 'media', a.id)},
      {label: 'Add to sequence', disabled: !['image','video'].includes(a.kind), run: () => addToSequence(a)},
      {label: 'Organize in bins', run: () => setBinAssetId(a.id)},
      ...(a.kind === 'image' && ['Character','Element'].includes(a.category) ? [
        {label: a.soulIdentityId ? 'Change Soul ID' : 'Attach Soul ID', disabled:a.locked, run: () => setSoulTarget({draftId:p.id,subjectType:a.category==='Character'?'character':'element',assetId:a.id})},
        ...(a.soulIdentityId ? [{label:'Remove Soul ID binding',disabled:a.locked,run:()=>updateAsset(a.id,{soulIdentityId:undefined,version:a.version+1})}] : []),
      ] : []),
      {label: 'Copy prompt', disabled: !a.prompt, run: () => { void navigator.clipboard.writeText(a.prompt || '').then(() => toast.success('Prompt copied')).catch(() => toast.error('Clipboard access is unavailable. Open the asset to copy its prompt.')); }},
    ];
  }
  function updateAsset(id: string, fields: Partial<Asset>) {
    change((old) => ({
      ...old,
      assets: old.assets.map((a) => (a.id === id ? { ...a, ...fields } : a)),
    }));
  }
  function addNode(type: CanvasNode["type"], assetId?: string, title?: string) {
    const a = assetsById.get(assetId || "");
    const node: CanvasNode = {
      id: uid("node"),
      type,
      assetId,
      title: title || a?.name || "Untitled " + type,
      x: 420 + (p.nodes.length % 3) * 85,
      y: 180 + (p.nodes.length % 4) * 70,
      width: type === "scene" ? 442 : 286,
      linked: selectedNode ? [selectedNode] : [],
      text:
        type === "note"
          ? "Add a direction, question or production note."
          : undefined,
    };
    change((old) => ({ ...old, nodes: [...old.nodes, node] }));
    setSelectedNode(node.id);
    setStage("canvas");
    setDialog(null);
    setScope("My space");
    toast("Added to your canvas");
  }
  async function publishSelection() {
    if(transitioningRef.current||publishingRef.current)return;
    const project=pRef.current;
    const node = project.nodes.find((n) => n.id === selectedNode);
    if (!node) {
      toast("Select a node to publish");
      return;
    }
    const ids = new Set<string>();
    function visit(id: string) {
      if (ids.has(id)) return;
      ids.add(id);
      project.nodes.find((n) => n.id === id)?.linked.forEach(visit);
    }
    visit(node.id);
    const assetIds = new Set(
      project.nodes
        .filter((n) => ids.has(n.id))
        .flatMap((n) => (n.assetId ? [n.assetId] : [])),
    );
    const sharedNodes = structuredClone([
      ...(
        project.sharedNodes || project.nodes.filter((n) => project.sharedNodeIds.includes(n.id))
      ).filter((n) => !ids.has(n.id)),
      ...project.nodes.filter((n) => ids.has(n.id)),
    ]);
    const sharedAssets = structuredClone([
      ...(
        project.sharedAssets ||
        project.assets.filter((a) => project.sharedAssetIds.includes(a.id))
      ).filter((a) => !assetIds.has(a.id)),
      ...project.assets.filter((a) => assetIds.has(a.id)),
    ]);
    const next={...pRef.current,sharedNodeIds:sharedNodes.map(n=>n.id),sharedAssetIds:sharedAssets.map(a=>a.id),sharedNodes,sharedAssets};
    pRef.current=next;setP(next);await publishBible(project.id);
  }
  async function uploadFiles(
    files: FileList | File[] | null,
    category = uploadCategory.current,
  ) {
    if (!files?.length||transitioningRef.current) return [];
    const draftId=pRef.current.id;
    uploadingRef.current++;
    setUploading(true);
    const received: Asset[] = [];
    for (const file of Array.from(files)) {
      try {
        if(!signedIn)throw new Error('Sign in to upload project media.');
        if(!readyRef.current)throw new Error('Create a project before uploading media.');
        const data=await uploadWorkbench(file,undefined,storageKey);
        received.push({
          id: data.id,
          uploadId: data.id,
          name: file.name,
          kind: file.type.startsWith("image/")
            ? "image"
            : file.type.startsWith("video/")
              ? "video"
              : file.type.startsWith("audio/")
                ? "audio"
                : "document",
          category,
          url: data.url,
          mime: file.type,
          description: "Uploaded from device",
          prompt: "",
          status: "Draft",
          version: 1,
          locked: false,
          refs: [],
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Upload failed");
      }
    }
    if (received.length&&pRef.current.id===draftId) {
      change((old) => ({ ...old, assets: [...old.assets, ...received] }));
      setContextIds((old) => [...old, ...received.map((a) => a.id)]);
      toast.success(
        `${received.length} reference${received.length === 1 ? "" : "s"} added`,
      );
    }
    uploadingRef.current--;
    setUploading(uploadingRef.current>0);
    if (fileInput.current) fileInput.current.value = "";
    return pRef.current.id===draftId ? received : [];
  }
  async function importSequenceLut(file: File) {
    if (!signedIn || !readyRef.current || transitioningRef.current) throw new Error('Open a saved project before importing a LUT.');
    const draftId = pRef.current.id;
    uploadingRef.current++; setUploading(true);
    try {
      const data = await uploadWorkbench(file, undefined, storageKey);
      if (pRef.current.id !== draftId || transitioningRef.current) throw new Error('The project changed. The original LUT remains in your workspace uploads.');
      const asset: Asset = { id:data.id, uploadId:data.id, name:file.name.slice(0,200), kind:'document', category:'LUT', url:data.url, mime:data.mime, description:'Original 3D color LUT', prompt:'', status:'Draft', version:1, locked:false, refs:[] };
      change(previous => ({ ...previous, assets:[...previous.assets,asset], colorGrade:{...defaultColorGrade,...previous.colorGrade,lutAssetId:asset.id,bypassed:false} }));
      if (!(await ensureSaved(draftId))) throw new Error('The LUT uploaded. Save this project before leaving to retain its binding.');
      toast.success('LUT imported and applied to the sequence.');
    } finally { uploadingRef.current--; setUploading(uploadingRef.current>0); }
  }
  function pickUpload(category = "Reference") {
    uploadCategory.current = category;
    fileInput.current?.click();
  }
  function addLink() {
    try {
      const url = new URL(referenceUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      const a: Asset = {
        id: uid("link"),
        name: url.hostname,
        kind: "link",
        category: "Reference",
        url: url.href,
        description: "Reference link · selected metadata included in context",
        prompt: "",
        status: "Draft",
        locked: false,
        version: 1,
        refs: [],
      };
      change((old) => ({ ...old, assets: [...old.assets, a] }));
      setContextIds((old) => [...old, a.id]);
      setReferenceUrl("");
      setDialog(null);
      toast.success("Reference link added");
    } catch {
      toast.error("Enter a valid https:// or http:// link");
    }
  }
  async function runGenie(text = prompt, role?: string, detail = depth) {
    if(!text.trim()||busy||transitioningRef.current)return;setBusy(true);
    const draftId=pRef.current.id;
    try{if(!(await ensureSaved(draftId))||transitioningRef.current||pRef.current.id!==draftId)return;setAtomikTarget({request:text,role,model,effort,depth:detail,refs:contextIds,draftId});}
    catch(e){toast.error(e instanceof Error?e.message:'Atomik could not start.')}finally{setBusy(false)}
  }
  function applyPlan(plan: Plan) {
    if (plan.applied) return;
    if(p.nodes.length+plan.steps.length>250){toast.error('The canvas supports 250 nodes. Remove some nodes before adding this plan.');return;}
    const marketing=isMarketingPlan(plan);
    const nodes: CanvasNode[] = plan.steps.map((s, i) => ({
      id: uid("node"),
      title:
        marketing ? `Campaign / ${i + 1}` : plan.intent === "continuity"
          ? `Continuity / ${i + 1}`
          : plan.intent === "shots"
            ? `Shot / ${i + 1}`
            : `${["The idea", "Visual world", "Character & elements", "Hero scene", "Editorial"][i] || "Production note"}`,
      type:
        marketing || plan.intent === "continuity"
          ? "note"
          : ((["brief", "moodboard", "character", "scene", "note"][i] ||
              "note") as CanvasNode["type"]),
      text: s,
      ...(marketing?{role:'Marketing strategist'}:{}),
      assetId:
        marketing || plan.intent === "continuity"
          ? undefined
          : plan.refs[i % Math.max(plan.refs.length, 1)],
      x: 60 + (i % 3) * 350,
      y: 1030 + Math.floor(i / 3) * 320,
      width: 300,
      linked: marketing ? p.nodes.filter(node=>node.assetId&&plan.refs.includes(node.assetId)).map(node=>node.id).slice(0,99) : [],
    }));
    for (let i = 1; i < nodes.length; i++) nodes[i].linked = [...nodes[i].linked,nodes[i - 1].id];
    change((old) => ({
      ...old,
      nodes: [...old.nodes, ...nodes],
      plans: old.plans.map((a) =>
        a.id === plan.id ? { ...a, applied: true } : a,
      ),
    }));
    setStage("canvas");
    setScope("My space");
    setSelectedNode(nodes[0]?.id || null);
    setPan({ x: 20, y: -760 });
    setZoom(0.76);
    toast.success(`${nodes.length} editable nodes added to your space`);
  }
  function exploreCrew(role?:string){
    if(!role){setAtomTab('crew');toast('Choose the department needed for this task.');return;}
    if(role==='marketing'){setAtomTab('marketing');return;}
    void runGenie('Develop the '+(CREW.find(c=>c.id===role)?.name||'department')+' plan for '+p.name,role);
  }
  async function openProduction(id:string){
    const transition=await beginTransition();if(!transition)return;
    try{
      const data=await studioRequest<{project:Project}>('/api/workbench/projects',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':storageKey},body:JSON.stringify({action:'open',projectId:id})});
      if(transition.token!==loadToken.current)return;
      if(transition.wasReady&&signedIn&&!(await drainSaves(transition.from)))throw new Error('Your latest changes could not be saved.');
      if(transition.token!==loadToken.current)return;
      setWelcomeChoice(false);setSamplePreview(false);adoptProject(data.project,0,false);setStage('canvas');setScope('My space');toast.success('Your own working space is ready.');
    }catch(error){if(transition.token===loadToken.current){readyRef.current=transition.wasReady;setReady(transition.wasReady);toast.error(error instanceof Error?error.message:'Could not open project.');}}
    finally{endTransition(transition.token);}
  }
  async function publishBible(expectedId=pRef.current.id){
    if(publishingRef.current||transitioningRef.current)return false;
    publishingRef.current=true;
    try{
      if(!(await ensureSaved(expectedId)))return false;
      const data=await studioRequest<{version:number;shared:{assets:Asset[];nodes:CanvasNode[]}}>('/api/workbench/projects',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':storageKey},body:JSON.stringify({action:'publish',projectId:expectedId,expectedBibleVersion:pRef.current.bibleVersion??0})});
      if(pRef.current.id===expectedId){const next={...pRef.current,bibleVersion:data.version,...(data.shared?{sharedAssets:data.shared.assets,sharedNodes:data.shared.nodes,sharedAssetIds:data.shared.assets.map(a=>a.id),sharedNodeIds:data.shared.nodes.map(n=>n.id)}:{})};pRef.current=next;setP(next);setBibleConflict(null);toast.success('Shared project bible v'+data.version+' published.');}
      return true;
    }catch(error){if(error instanceof StudioRequestError&&error.data.code==='bible_conflict'&&pRef.current.id===expectedId)setBibleConflict({draftId:expectedId,version:Number(error.data.currentVersion)||0,message:error.message});toast.error(error instanceof Error?error.message:'Could not publish.');return false;}
    finally{publishingRef.current=false;}
  }
  async function publishAsset(assetId:string){
    if(transitioningRef.current||publishingRef.current)return;
    const current=pRef.current,asset=current.assets.find(a=>a.id===assetId);if(!asset)return;
    change(old=>({...old,sharedAssetIds:[...new Set([...old.sharedAssetIds,assetId])],sharedAssets:[...(old.sharedAssets??old.assets.filter(a=>old.sharedAssetIds.includes(a.id))).filter(a=>a.id!==assetId),structuredClone(asset)]}));
    await publishBible(current.id);
  }
  async function importScreenplay(file:File,result:ScreenplayImport) {
    if(transitioningRef.current || !signedIn || !readyRef.current)throw new Error('Create and save a project before importing.');
    const draftId=pRef.current.id;
    if(pRef.current.scriptSource?.sha256===result.sha256 && pRef.current.script===result.text && JSON.stringify(pRef.current.scriptSource.ocr)===JSON.stringify(result.ocr)){if(!(await ensureSaved(draftId)))throw new Error('The import is still unsaved. Retry when the connection returns.');return;}
    if(pRef.current.assets.length>=500)throw new Error('The asset library is full. Make space for the original screenplay first.');
    uploadingRef.current++;setUploading(true);
    try {
      const uploaded=await uploadWorkbench(file,undefined,storageKey);
      if(pRef.current.id!==draftId)throw new Error('The project changed. The uploaded original remains in your workspace.');
      const asset:Asset={id:uploaded.id,uploadId:uploaded.id,name:file.name.slice(0,200),kind:'document',category:pRef.current.scriptFormat==='adfilm'?'Ad-film script':'Screenplay',url:uploaded.url,mime:uploaded.mime||file.type,description:pRef.current.scriptFormat==='adfilm'?'Original ad-film script source':'Original screenplay source',prompt:'',status:'Draft',version:1,locked:false,refs:[]};
      change(old=>({...old,script:result.text,scriptReviews:{},scriptSource:{assetId:asset.id,filename:asset.name,sha256:result.sha256,pages:result.pages,importedAt:new Date().toISOString(),edited:false,acknowledgedEmptyPages:result.emptyPages,ocr:result.ocr},assets:[...old.assets,asset]}));
      if(!(await ensureSaved(draftId)))throw new Error('The source uploaded, but the project is not saved yet. Retry this import to save it without uploading again.');
    } finally {uploadingRef.current--;setUploading(uploadingRef.current>0);}
  }
  async function applyDevelopmentResult(job: DevelopmentJob, choice: {idea:number}|{scenes:string[]}) {
    const current = pRef.current;
    if (transitioningRef.current || job.projectId !== current.id) throw new Error('Return to the project that created this result.');
    const source = sourceCanonical(current, job.kind);
    if (await developmentSourceHash(current, job.kind) !== job.sourceHash) throw new Error('The source changed after this development run. Review the saved result or run development again.');
    if (transitioningRef.current || pRef.current.id !== current.id || sourceCanonical(pRef.current, job.kind) !== source) throw new Error('The project changed while checking the result. Try again.');
    const next = applyDevelopment(pRef.current, job, choice);
    change(() => next);
    if (!(await ensureSaved(current.id))) throw new Error('The result was added locally, but is not saved yet. Keep this project open and retry saving.');
    toast.success('idea' in choice ? 'Idea added to creative direction.' : 'Scene breakdown added to the canvas.');
  }
  function buildScriptCanvas(scenes: ScriptScene[]) {
    try {
      const nodes=buildScreenplayNodes(pRef.current,scenes);
      change(old=>({...old,nodes:[...old.nodes,...nodes]}));
      setStage('canvas');setPan({x:10,y:-770});setZoom(.76);setScope('My space');
      toast.success(nodes.length+' complete scene nodes added with source and beat notes.');
    } catch(error){toast.error(error instanceof Error?error.message:'Could not build these scenes.');}
  }
  function editNode(n: CanvasNode) {
    setEditingNode(n.id);
    setNodeName(n.text || n.title);
    setNodeKind(n.type.charAt(0).toUpperCase() + n.type.slice(1));
    setDialog("node");
  }
  function autoArrange() {
    change((old) => ({
      ...old,
      nodes: old.nodes.map((n, i) => ({
        ...n,
        x: 50 + (i % 3) * 370,
        y: 75 + Math.floor(i / 3) * 320,
      })),
    }));
    setPan({ x: 10, y: 10 });
    setZoom(0.74);
  }
  function addToSequence(a: Asset) {
    if (!["image", "video"].includes(a.kind)) return;
    const shot: Shot = {
      id: uid("shot"),
      name: String(p.shots.length + 1).padStart(2, "0") + " — " + a.name,
      assetId: a.id,
      duration: p.fps * 5,
      sourceIn: 0,
      note: a.description,
    };
    change((old) => ({ ...old, shots: [...old.shots, shot] }));
    toast.success("Added to the sequence");
  }
  function moveShot(id: string, direction: number) {
    change((old) => {
      const shots = [...old.shots];
      const i = shots.findIndex((s) => s.id === id),
        j = i + direction;
      if (i < 0 || j < 0 || j >= shots.length) return old;
      [shots[i], shots[j]] = [shots[j], shots[i]];
      return { ...old, shots };
    });
  }
  async function createProduction() {
    const name=newName.trim();if(!name)return;
    const transition=await beginTransition();if(!transition)return;
    try{
      if(transition.token!==loadToken.current)return;
      const next=newProject(name);setWelcomeChoice(false);setSamplePreview(false);adoptProject(next,0,false);
      setNewName('');setDialog(null);setStage('brief');setScope('My space');setContextIds([]);
    }finally{endTransition(transition.token);}
  }
  async function leaveWorkspace(path:string,action?:{kind:'switch';id:string}|{kind:'logout'}){
    const transition=await beginTransition();if(!transition)return;
    try{
      if(action){const response=await fetch(action.kind==='switch'?'/api/workspaces/switch':'/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Scope':storageKey},body:JSON.stringify(action.kind==='switch'?{id:action.id}:{})});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Your account could not be changed.');}clearPrivateLocal();}
      window.location.assign(path);
    }catch(error){readyRef.current=transition.wasReady;setReady(transition.wasReady);setSaveState(transition.wasReady?'Saved':'Choose a project');toast.error(error instanceof Error?error.message:'Your current work has been kept. Try again.');endTransition(transition.token);}
  }
  function exploreSample(){setWelcomeChoice(false);setSamplePreview(true);const sample=seedProject();pRef.current=sample;setP(sample);setStage('canvas');setSaveState('Sample preview');setSelectedNode('scene');}
  function focusShot(s: Shot) {
    setShotId(s.id);
    let start = 0;
    for (const shot of p.shots) {
      if (shot.id === s.id) break;
      start += shot.duration;
    }
    setFrame(start);
    setPlaying(false);
  }
  const nodes =
    scope === "Shared production"
      ? p.sharedNodes || p.nodes.filter((n) => p.sharedNodeIds.includes(n.id))
      : p.nodes;
  const latestPlan = p.plans.at(-1);
  function renderMarketingPanel(){return <MarketingStudioPanel key={p.id} task={marketingDraft.task} instructions={marketingDraft.instructions} onTask={task=>setMarketingDrafts(old=>({...old,[marketingDraftKey]:{...marketingDraft,task}}))} onInstructions={instructions=>setMarketingDrafts(old=>({...old,[marketingDraftKey]:{...marketingDraft,instructions}}))} project={p} enabled={ready&&signedIn&&!transitioning} busy={busy} references={contextIds.length} jobs={jobs.atomikJobs} error={jobs.error} onBriefChange={brief=>change(old=>({...old,marketingBrief:brief}))} onRun={request=>void runGenie(request,'marketing','Considered')} onApply={applyPlan} onContext={()=>{setAtomOpen(true);setAtomTab('context')}} onActivity={()=>{setAtomOpen(true);setAtomTab('runs')}}/>;}
  function configureMoleculr(hook:string,castId:string|undefined,kind:'image'|'video'){
    if(transitioningRef.current||!readyRef.current||!signedIn)return;
    const current=pRef.current,brief=current.moleculr??EMPTY_MOLECULR;
    const existing=brief.variants.find(item=>item.hook===hook&&item.castAssetId===castId&&current.nodes.some(node=>node.id===item.nodeId));
    if(existing&&current.nodes.find(item=>item.id===existing.nodeId)?.locked){toast.error('This variant is locked in Rig. Unlock it before changing its generation.');return;}
    if(!existing&&(current.nodes.length>=250||brief.variants.length>=100)){toast.error('This project has reached its variant or node limit. Start another project to continue.');return;}
    const request=moleculrPrompt(current,brief,hook,castId);
    const nodeId=existing?.nodeId??uid('variant');
    const planned=moleculrNode(nodeId,request,`${brief.productName||current.name} · ${hook}`,current.nodes.length,kind);
    try{
      const base=existing?{...current.nodes.find(item=>item.id===nodeId)!,text:request,mode:planned.mode}:planned;
      const binding=bindMoleculrReferences(current,base,moleculrReferences(current,brief,castId),()=>uid('reference'));
      const nextNodes=[...(existing?current.nodes.map(item=>item.id===nodeId?binding.node:item):[...current.nodes,binding.node]),...binding.sources];
      change(old=>({...old,nodes:nextNodes,moleculr:{...brief,variants:existing?brief.variants:[...brief.variants,{id:uid('campaign'),nodeId,hook,castAssetId:castId}]}}));
      setGenerationTarget({node:binding.node,prompt:request,refs:generationReferenceIds(binding.node,{...current,nodes:nextNodes}),draftId:current.id});
    }catch(error){toast.error(error instanceof Error?error.message:'The variant could not be configured.');}

  }

  return (
    <TooltipProvider delayDuration={250}>
      <UploadRecovery scope={signedIn ? storageKey : null} />
      <div className="ps four-suite-workbench" data-suite={suite} style={atomikSize.style}>
        <div
          className={
            "studio-shell studio-redesign " +
            (home ? "is-home " : "") + (welcomeChoice ? "is-welcome " : "") +
            (sequenceExpanded ? "mobile-sequence-expanded" : "")
          }
          data-stage={stage}
          inert={transitioning?true:undefined}
          aria-busy={transitioning}
        >
          <main className="studio-main">
            {mobile && <header className="phone-project-header">
              {home ? <MobileStudioMenu projectId={ready?p.id:undefined} active="studio" initialAccount={initialAccount} onNavigate={path=>leaveWorkspace(path)} onSwitch={id=>leaveWorkspace('/workbench',{kind:'switch',id})} onSignOut={()=>leaveWorkspace('/login',{kind:'logout'})}/> : <button className="phone-back" aria-label="Back to project workflow" onClick={()=>setMobileWorkflowOpen(true)}><ArrowLeft size={18}/></button>}
              {home ? <button className="phone-project-crumb" aria-label="Select project" onClick={()=>setMobileWorkflowOpen(true)}><span>{p.name}</span><ChevronDown size={12}/><strong>Workspace</strong></button> : <button className="phone-project-crumb" onClick={()=>setMobileWorkflowOpen(true)}><span>{p.name}</span><ChevronRight size={12}/><strong>{String(STAGES.findIndex(s=>s.id===stage)+1).padStart(2,'0')} {['Brief','Script','Look','Cast','Elements','Canvas','Boards','Takes','Edit','Deliver'][STAGES.findIndex(s=>s.id===stage)]}</strong></button>}
              <button className={'phone-save '+(saveError?'has-error':'')} aria-label={saveState} title={saveState} onClick={()=>saveError&&toast.error(saveError)}>{saveError?<TriangleAlert size={12}/>:saveState==='Saving'?<Loader2 size={12} className="spin"/>:saveState==='Saved'?<Check size={12}/>:null}<span>{home && initialAccount?.credits ? `${Math.round(initialAccount.credits.balance).toLocaleString()} cr` : saveState.startsWith('Sample')?'Sample':saveState}</span></button>
              <button className="phone-all-assets" aria-label="All assets" onClick={()=>void leaveWorkspace("/library?all=1&project="+encodeURIComponent(p.id))}><FolderOpen size={18}/></button>
              <button className="phone-atomik" aria-label="Toggle Atomik creative engine" disabled={!hydrated} onClick={()=>setAtomOpen(v=>!v)}><AtomMark/><span>Atomik</span></button>
            </header>}

            <div className="project-bar">
              <Link className="suite-wordmark" href="/" prefetch={false} onNavigate={e=>{e.preventDefault();void leaveWorkspace('/')}} aria-label="Particl home"><Image src="/brand/particl-wordmark-on-dark@4x.png" alt="Particl" width={68} height={22}/></Link>
              <SuiteSwitcher suite={suite} projectId={ready?p.id:undefined} onNavigate={path=>leaveWorkspace(path)}/>
              <div className="project-breadcrumb">
                <button onClick={() => setHome(true)}>Projects</button>
                <ChevronRight size={12} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="project-switch">
                      <span className="project-monogram">
                        {p.name
                          .split(/\s+/)
                          .map((w) => w[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()}
                      </span>
                      {p.name}
                      <ChevronDown size={13} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="ps">
                    <DropdownMenuItem onClick={() => setDialog("project")}>
                      <Plus size={14} />
                      New project
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={()=>void leaveWorkspace(`/pipelines${p.productionProjectId?`?projectId=${encodeURIComponent(p.productionProjectId)}`:""}`)}>Pipelines</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setStage("brief")}>
                      Edit project brief
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={()=>void publishBible()}>Publish project bible</DropdownMenuItem>
                    {productions.map(item=><DropdownMenuItem key={'prod-'+item.id} onClick={()=>void openProduction(item.id)}>Open {item.name} in my space</DropdownMenuItem>)}
                    {projects
                      .filter((a) => a.id !== p.id)
                      .map((a) => (
                        <DropdownMenuItem
                          key={a.id}
                          onClick={() => {
                            void loadProject(a.id);
                            setStage("canvas");
                          }}
                        >
                          {a.name}
                        </DropdownMenuItem>
                      ))}
                    <DropdownMenuItem
                      onClick={() =>
                        downloadFile(
                          new Blob([JSON.stringify(p, null, 2)], {
                            type: "application/json",
                          }),
                          safeName(p.name) + ".json",
                        )
                      }
                    >
                      Download project data
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="project-description">{p.description}</span>
              </div>
              <div className="project-bar-actions">
              <div className="workflow-utilities">
                <button className="all-assets-button" aria-label="All assets" onClick={()=>void leaveWorkspace("/library?all=1&project="+encodeURIComponent(p.id))}><FolderOpen size={15}/><span>All assets</span></button>
                <button
                  className={"atomik-toggle " + (atomOpen ? "on" : "")}
                  aria-label="Toggle Atomik creative engine"
                  aria-expanded={atomOpen}
                  aria-controls="atomik-panel"
                  disabled={!hydrated}
                  onClick={() => setAtomOpen((v) => !v)}
                >
                  <AtomMark />
                  <span>Atomik</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="studio-settings"
                      aria-label="Studio settings"
                    >
                      <Settings2 size={17} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="ps">
                    <DropdownMenuItem onClick={() => setDialog("shortcuts")}>
                      Keyboard shortcuts
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={()=>void leaveWorkspace(signedIn?'/settings':'/login')}>{signedIn?'Account & workspace':'Sign in'}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog("connections")}>
                      Connected engines
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog("review")}>
                      Studio guide
                    </DropdownMenuItem>
                    {!sourceMode && (
                      <DropdownMenuItem asChild>
                        <a href="/particl-redesign-source.zip" download>
                          Download redesigned repository
                        </a>
                      </DropdownMenuItem>
                    )}
                    {sourceMode && (
                      <DropdownMenuItem onSelect={()=>void leaveWorkspace("/generate?project="+encodeURIComponent(p.id))}>Open Gen</DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

                <WorkspaceMenu initial={initialAccount} onNavigate={path=>leaveWorkspace(path)} onSwitch={id=>leaveWorkspace("/workbench",{kind:"switch",id})} onSignOut={()=>leaveWorkspace("/login",{kind:"logout"})}/>
                <span className="project-spec">
                  {p.aspect}
                  <i />
                  {p.fps} fps
                </span>
                <button
                  className={"save-label " + (saveError ? "save-problem" : "")}
                  onClick={() =>
                    saveError ? toast.error(saveError) : undefined
                  }
                >
                  {saveState === "Saved" ? (
                    <Check size={12} />
                  ) : saveState === "Saving" ? (
                    <Loader2 size={12} className="spin" />
                  ) : null}
                  {saveState}
                </button>
              </div>
            </div>
            {saveError && (
              <div className="save-banner">
                <TriangleAlert size={14} />
                <span>{saveError}</span>
                <button
                  onClick={() => {
                    if (failedSave.current) {
                      failedSave.current = false;
                      pendingSave.current = pRef.current;
                      void flushSave();
                    } else void loadProject(failedLoad.current?.id??p.id);
                  }}
                >
                  Retry
                </button>
                <button
                  onClick={() =>
                    downloadFile(
                      new Blob([JSON.stringify(p, null, 2)], {
                        type: "application/json",
                      }),
                      "particl-unsaved.json",
                    )
                  }
                >
                  Download current work
                </button>
              </div>
            )}
            {bibleConflict?.draftId===p.id&&<div className="save-banner" role="alert">
              <TriangleAlert size={14}/><span>Shared context v{bibleConflict.version} is newer. Your private work is kept. Save it before loading the latest shared context, then choose what to publish again.</span>
              <button disabled={transitioning} onClick={()=>void loadProject(p.id)}>Save &amp; load latest shared context</button>
              <button onClick={()=>downloadFile(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),'particl-unpublished-context.json')}>Download current work</button>
            </div>}
            <div
              className={"workspace-body " + (atomOpen ? "with-atomik" : "")}
            >
              {suite==='particl'&&<RoomRail active="production" projectId={ready?p.id:undefined} onNavigate={path=>leaveWorkspace(path)}/>}
              <section
                className={
                  "work-area " +
                  (suite==='particl' && stage === "canvas" && !home ? "graph-area" : "")
                }
              >
                {welcomeChoice&&<section className="production-welcome"><span className="eyebrow">YOUR WORKSPACE IS READY</span><h1>What are you making next?</h1><p>Start a project for your team, or explore how a brief becomes a sequence in the sample workspace.</p><div className="production-welcome-actions"><Button className="btn primary" onClick={()=>setDialog('project')}>Start a project<Plus size={16}/></Button><Button className="btn" onClick={exploreSample}>Explore sample<ArrowUpRight size={16}/></Button></div>{projects.length>0&&<div className="production-welcome-existing"><h2>Your saved projects</h2>{projects.map(project=><button key={project.id} onClick={()=>{void loadProject(project.id);setStage('canvas')}}>{project.name}<ArrowUpRight size={15}/></button>)}</div>}{productions.length>0&&<div className="production-welcome-existing"><h2>Workspace projects</h2>{productions.map(project=><button key={project.id} onClick={()=>void openProduction(project.id)}>{project.name}<ArrowUpRight size={15}/></button>)}</div>}<div className="production-welcome-steps"><span>01 · Name your project</span><span>02 · Bring your references</span><span>03 · Make your first take</span><span>04 · Review and deliver</span></div><button className="workbench-welcome-team" onClick={()=>void leaveWorkspace('/team')}>Invite your team</button></section>}
                {samplePreview&&<div className="sample-preview-banner"><span>Sample preview · Create a project to save your own work.</span><button onClick={()=>setDialog('project')}>Start a project</button></div>}
                {home && !welcomeChoice && (
                  <div className="production-home">
                    <div className="home-heading">
                      <div>
                        <span className="eyebrow">YOUR STUDIO</span>
                        <h1>Projects</h1>
                      </div>
                      <Button
                        aria-label="New project"
                        className="btn primary"
                        onClick={() => setDialog("project")}
                      >
                        <Plus size={16} />
                        New project
                      </Button>
                    </div>
                    <div className="home-projects">
                      <button
                        className="home-current"
                        disabled={mobile&&(!hydrated||(signedIn&&initializedScope!==storageKey)||transitioning)}
                        onClick={() => setStage("canvas")}
                      >
                        <div className="home-project-cover">
                          <Media
                            asset={p.assets.find((a) => a.kind === "image")}
                          />
                          <span className="home-cover-continue">
                            CONTINUE WORKING
                            <ArrowUpRight size={18} />
                          </span>
                          {mobile&&<div className="phone-cover-chips"><span>{p.aspect} · {p.fps} FPS</span>{samplePreview&&<span>Sample</span>}</div>}
                        </div>
                        <div>
                          <span className="home-project-icon">
                            <Clapperboard size={20} />
                          </span>
                          <div>
                            <h2>{p.name}</h2>
                            {mobile&&<span className="phone-project-meta">{p.shots.length} shots · {(totalFrames/p.fps).toFixed(0)}s</span>}
                            <p>
                              {p.description} · {p.nodes.length} nodes ·{" "}
                              {p.shots.length} shots
                            </p>
                          </div>
                          <ArrowRight size={19} />
                        </div>
                        {mobile&&<div className="phone-project-progress"><div>{STAGES.map(s=><i key={s.id} className={s.id===stage?'current':''}/>)}</div><span>{String(STAGES.findIndex(s=>s.id===stage)+1).padStart(2,'0')} · {STAGES.find(s=>s.id===stage)?.label}<b>Open →</b></span></div>}
                      </button>
                      {mobile&&<button className="phone-new-project" onClick={()=>setDialog('project')}><Plus size={18}/>Start a project</button>}
                      {projects
                        .filter((a) => a.id !== p.id)
                        .map((a) => (
                          <button
                            className="home-other-project"
                            key={a.id}
                            onClick={() => {
                              void loadProject(a.id);
                              setStage("canvas");
                            }}
                          >
                            <Folder size={25} />
                            <h2>{a.name}</h2>
                            <span>
                              Open project
                              <ArrowUpRight size={15} />
                            </span>
                          </button>
                        ))}
                    </div>
                    {mobile&&<h3 className="phone-recent-label">PROJECT SHORTCUTS</h3>}
                    <div className="mobile-home-shortcuts">
                      <button onClick={() => setStage("canvas")}>
                        <GitBranch size={21} />
                        <span>Build the canvas</span>
                        <small>{p.nodes.length} nodes</small>
                      </button>
                      <button onClick={() => setStage("storyboard")}>
                        <Clapperboard size={21} />
                        <span>Storyboards</span>
                        <small>{p.shots.length} shots</small>
                      </button>
                      <button
                        onClick={() => {
                          setAtomOpen(true);
                          setAtomTab("crew");
                        }}
                      >
                        <Sparkles size={21} />
                        <span>Your crew</span>
                        <small>7 departments</small>
                      </button>
                    </div>
                    <div className="home-workflow">
                      <h3>One project. Every department.</h3>
                      <div>
                        {STAGES.map((s, i) => {
                          const Icon = icons[i];
                          return (
                            <button key={s.id} onClick={() => setStage(s.id)}>
                              <small>{String(i + 1).padStart(2, "0")}</small>
                              <Icon size={21} />
                              <span>{s.label}</span>
                              <p>{s.hint}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
                {!home && !welcomeChoice && suite==='moleculr' && <MoleculrWorkspace key={p.id} project={p} page={moleculrPage} enabled={ready&&signedIn&&!transitioning} marketing={renderMarketingPanel()} onChange={brief=>change(old=>({...old,moleculr:brief}))} onPage={setMoleculrPage} onUpload={pickUpload} onIdentity={assetId=>setSoulTarget({draftId:p.id,subjectType:'character',assetId})} onStage={setStage} onRig={id=>{setSelectedNode(id);setScope('My space');setStage('canvas')}} onGenerate={configureMoleculr} onSequence={addToSequence} onAgent={()=>{setAtomOpen(true);setAtomTab('genie')}}/>}
                {!home && !welcomeChoice && suite==='particl' && (
                  <>
                    {stage !== "canvas" && (
                      <div className="page-heading">
                        <div>
                          <div className="eyebrow">
                            {mobile ? `${String(STAGES.findIndex(s=>s.id===stage)+1).padStart(2,"0")} / ${["THE IDEA","THE STORY","THE LOOK","THE CAST","THE WORLD","PRODUCTION CANVAS","STORYBOARDS","ASSETS & TAKES","EDIT & SOUND","DELIVERY"][STAGES.findIndex(s=>s.id===stage)]}` : ["brief", "script"].includes(stage)
                              ? "DEVELOPMENT"
                              : ["edit", "export"].includes(stage)
                                ? "POST-PRODUCTION"
                                : "PRODUCTION"}
                          </div>
                          <h1>{STAGES.find((s) => s.id === stage)?.label}</h1>
                        </div>
                        <div className="heading-context">
                          <span>
                            {STAGES.find((s) => s.id === stage)?.hint}
                          </span>
                        </div>
                      </div>
                    )}
                    {stage === "canvas" && (
                      <>
                        <div className="sequence-shelf">
                          <div className="canvas-stage-heading"><span className="eyebrow">BRING IT ALL TOGETHER</span><h1>Production canvas</h1></div>
                          <div className="shelf-label">
                            <button
                              className="mobile-sequence-toggle"
                              aria-label={
                                sequenceExpanded
                                  ? "Collapse sequence"
                                  : "Expand sequence"
                              }
                              aria-expanded={sequenceExpanded}
                              onClick={() =>
                                setSequenceExpanded(!sequenceExpanded)
                              }
                            >
                              <ChevronDown size={17} />
                            </button>
                            <Film size={15} />
                            <strong>Sequence</strong>
                            <span>
                              {p.shots.length} shots ·{" "}
                              {(totalFrames / p.fps).toFixed(0)}s
                            </span>
                            <button onClick={() => setStage("edit")}>
                              Open edit
                              <ArrowUpRight size={13} />
                            </button>
                          </div>
                          <div className="shelf-frames">
                            {p.shots.map((s, i) => (
                              <button
                                key={s.id}
                                className="shelf-frame"
                                onClick={() => {
                                  focusShot(s);
                                  setStage("edit");
                                }}
                              >
                                <Media asset={assetsById.get(s.assetId)} />
                                <span>{String(i + 1).padStart(2, "0")}</span>
                                <small>
                                  {(s.duration / p.fps).toFixed(0)}s
                                </small>
                              </button>
                            ))}
                            <button
                              className="shelf-add"
                              aria-label="Add an asset to the sequence"
                              onClick={() => setStage("assets")}
                            >
                              <Plus size={19} />
                            </button>
                          </div>
                        </div>
                        <ProductionGraph
                          onGenerate={(node,prompt,refs)=>{if(!transitioningRef.current)setGenerationTarget({node,prompt,refs,draftId:pRef.current.id});}}
                          generatingNodeId={generatingNodeId}
                          project={p}
                          onChange={change}
                          selectedId={selectedNode}
                          onSelect={setSelectedNode}
                          onAsset={setSelectedAsset}
                          onSequence={addToSequence}
                          onUpload={() => pickUpload()}
                          onFiles={(files) => void uploadFiles(files)}
                          onUndo={undo}
                          onCrew={() => {
                            setAtomOpen(true);
                            setAtomTab("crew");
                          }}
                          onDeliver={() => setStage("export")}
                          onPublish={publishSelection}
                          scope={scope}
                          requestScope={storageKey}
                          onScope={setScope}
                          apiBase={apiBase}
                        />
                      </>
                    )}
                    {stage === "script" && (
                      <ScriptPanel
                        key={p.id}
                        project={p}
                        onScript={(v) => change(old=>({...old,script:v,scriptSource:old.scriptSource?{...old.scriptSource,edited:true}:undefined}))}
                        onFormat={(value) => setField('scriptFormat', value)}
                        development={<DevelopmentPanel key={p.id + (p.scriptFormat || 'screenplay')} project={p} kind={p.scriptFormat || 'screenplay'} scope={storageKey} enabled={signedIn && ready} models={jobs.models} onSave={() => ensureSaved(p.id)} onApply={applyDevelopmentResult}/> }
                        onImport={importScreenplay}
                        onReview={(id,review)=>change(old=>({...old,scriptReviews:{...old.scriptReviews,[id]:review}}))}
                        onBuild={buildScriptCanvas}
                        onDevelop={(scene)=>{try{void runGenie(sceneCoverageRequest(pRef.current,scene),"dop");}catch(error){toast.error(error instanceof Error?error.message:"Could not plan this scene.");}}}
                        onCrew={() => {
                          setAtomOpen(true);
                          setAtomTab("crew");
                        }}
                      />
                    )}
                    {stage === "storyboard" && (
                      <StoryboardPanel
                        project={p}
                        onEdit={(s) => {
                          focusShot(s);
                          setStage("edit");
                        }}
                        onAsset={setSelectedAsset}
                        onAdd={() => setStage("assets")}
                        onField={(shots) => setField("shots", shots)}
                      />
                    )}
                    {stage === "brief" && (
                      <div className="stage-scroll">
                        <div className="brief-grid">
                          <div className="brief-main">
                            <div className="section-heading">
                              <span className="eyebrow">01 / THE IDEA</span>
                              <span className="small-tag">Editable brief</span>
                            </div>
                            <label
                              className="field-label"
                              htmlFor="project-name"
                            >
                              Project title
                            </label>
                            <input
                              id="project-name"
                              className="title-input"
                              value={p.name}
                              maxLength={100}
                              onChange={(e) => setField("name", e.target.value)}
                            />
                            <label
                              className="field-label"
                              htmlFor="creative-brief"
                            >
                              What are we making?
                            </label>
                            <textarea
                              id="creative-brief"
                              className="large-textarea"
                              value={p.brief}
                              placeholder="Start with a thought, a script or a client brief…"
                              onChange={(e) =>
                                setField("brief", e.target.value)
                              }
                            />
                            <div className="two-fields">
                              <div>
                                <label
                                  className="field-label"
                                  htmlFor="audience"
                                >
                                  Audience
                                </label>
                                <textarea
                                  id="audience"
                                  value={p.audience}
                                  onChange={(e) =>
                                    setField("audience", e.target.value)
                                  }
                                />
                              </div>
                              <div>
                                <label
                                  className="field-label"
                                  htmlFor="deliverables"
                                >
                                  Deliverables
                                </label>
                                <textarea
                                  id="deliverables"
                                  value={p.deliverables}
                                  onChange={(e) =>
                                    setField("deliverables", e.target.value)
                                  }
                                />
                              </div>
                            </div>
                            <label className="field-label" htmlFor="direction">
                              Creative direction
                            </label>
                            <textarea
                              id="direction"
                              value={p.direction}
                              onChange={(e) =>
                                setField("direction", e.target.value)
                              }
                            />
                            <div className="form-footer">
                              <button onClick={() => pickUpload("Brief")}>
                                <Paperclip size={15} />
                                Attach a brief
                              </button>
                              <button onClick={() => { setAtomOpen(true); setAtomTab('genie'); }}><Sparkles size={15}/>Open Atomik conversation</button>
                            </div>
                            <DevelopmentPanel key={p.id + '-idea'} project={p} kind="idea" scope={storageKey} enabled={signedIn && ready} models={jobs.models} onSave={() => ensureSaved(p.id)} onApply={applyDevelopmentResult}/>
                          </div>
                          <aside className="brief-side">
                            <div className="brief-image">
                              <Media
                                asset={p.assets.find((a) => a.kind === "image")}
                              />
                              <span>THE WORLD WE’RE BUILDING</span>
                            </div>
                            <div className="brief-note">
                              <GitBranch size={20} />
                              <h3>
                                A shared direction.
                                <br />
                                Space to explore.
                              </h3>
                              <p>
                                The brief gives everyone a starting point. Each
                                person can take it somewhere new in their own
                                space.
                              </p>
                              <button onClick={() => setStage("moodboard")}>
                                Build the visual world
                                <ArrowRight size={15} />
                              </button>
                            </div>
                          </aside>
                        </div>
                      </div>
                    )}
                    {["moodboard", "characters", "elements", "assets"].includes(
                      stage,
                    ) && (
                      <div className="stage-scroll">
                        {stage === 'assets' && <div className="collective-assets-link"><div><strong>Project assets & takes</strong><p>Open the collective library for originals and takes across this workspace.</p></div><button className="btn" onClick={() => void leaveWorkspace('/library')}>All workspace assets <ArrowUpRight size={14}/></button></div>}
                        <div className="library-toolbar">
                          <div className="search-field">
                            <Search size={16} />
                            <input
                              aria-label="Search assets"
                              value={assetSearch}
                              onChange={(e) => setAssetSearch(e.target.value)}
                              placeholder={
                                stage === "characters"
                                  ? "Find a character…"
                                  : stage === "elements"
                                    ? "Find an element…"
                                    : "Find an asset…"
                              }
                            />
                          </div>
                          {stage === "assets" && (
                            <Choice
                              label="Filter assets"
                              value={assetFilter}
                              onChange={setAssetFilter}
                              options={[
                                "All assets",
                                "Images",
                                "Video",
                                "Audio",
                                "Documents",
                                "Shared",
                              ]}
                            />
                          )}
                          {(stage === 'characters' || stage === 'elements') && <Button variant="outline" className="btn" onClick={() => setSoulTarget({draftId:p.id,subjectType:stage==='characters'?'character':'element'})}><UserRound size={15}/>Soul ID</Button>}
                          <Button
                            variant="outline"
                            className="btn"
                            onClick={() => setDialog("reference")}
                          >
                            <Link2 size={15} />
                            Add link
                          </Button>
                          <Button
                            className="btn primary"
                            disabled={uploading}
                            onClick={() =>
                              pickUpload(
                                stage === "characters"
                                  ? "Character"
                                  : stage === "elements"
                                    ? "Element"
                                    : "Reference",
                              )
                            }
                          >
                            {uploading ? (
                              <Loader2 size={15} className="spin" />
                            ) : (
                              <Upload size={15} />
                            )}
                            Upload
                          </Button>
                        </div>
                        {stage === "assets" && <AssetBins key={p.id+storageKey} project={p} selected={selectedBin} onSelect={id=>setBinSelection({projectId:p.id,id})} onChange={change}/>}
                        {stage === "moodboard" && (
                          <>
                            <div className="moodboard-intro">
                              <div>
                                <span className="eyebrow">
                                  LOOK DEVELOPMENT
                                </span>
                                <h2>
                                  {p.id === "dune-studies"
                                    ? "Warm earth. Impossible reflections."
                                    : "The visual world of " + p.name}
                                </h2>
                                <p>
                                  {p.direction ||
                                    "Collect the light, colour, texture and feeling of your project."}
                                </p>
                              </div>
                              <div className="large-palette">
                                {["sand", "clay", "ivory", "steel", "ink"].map(
                                  (c) => (
                                    <div key={c}>
                                      <span className={"swatch " + c} />
                                      <small>{c}</small>
                                    </div>
                                  ),
                                )}
                              </div>
                            </div>
                          </>
                        )}
                        {stage === "characters" && (
                          <div className="stage-context">
                            <UserRound size={18} />
                            <p>
                              Identity, wardrobe, expression and voice—kept
                              together as reusable references.
                            </p>
                            <span className="small-tag">
                              Versions stay editable
                            </span>
                          </div>
                        )}
                        {stage === "elements" && (
                          <div className="stage-context">
                            <Box size={18} />
                            <p>
                              Locations, props, materials and looks. Build once
                              and reference across shots.
                            </p>
                          </div>
                        )}
                        <div
                          className={
                            "asset-grid " +
                            (stage === "moodboard" ? "mood-grid" : "")
                          }
                        >
                          {p.assets
                            .filter((a) => {
                              if(stage==='assets'&&selectedBin==='unfiled'&&(p.bins??[]).some(b=>b.assetIds.includes(a.id)))return false;
                              if(stage==='assets'&&selectedBin&&selectedBin!=='unfiled'&&p.bins?.some(b=>b.id===selectedBin)&&!p.bins.find(b=>b.id===selectedBin)!.assetIds.includes(a.id))return false;
                              if (
                                assetSearch &&
                                !`${a.name} ${a.description} ${a.category}`
                                  .toLowerCase()
                                  .includes(assetSearch.toLowerCase())
                              )
                                return false;
                              if (stage === "characters")
                                return a.category === "Character";
                              if (stage === "elements")
                                return [
                                  "Element",
                                  "Environment",
                                  "Prop",
                                  "Look",
                                ].includes(a.category);
                              if (stage === "moodboard")
                                return ["image", "link", "document"].includes(
                                  a.kind,
                                );
                              return (
                                assetFilter === "All assets" ||
                                (assetFilter === "Images" &&
                                  a.kind === "image") ||
                                (assetFilter === "Video" &&
                                  a.kind === "video") ||
                                (assetFilter === "Audio" &&
                                  a.kind === "audio") ||
                                (assetFilter === "Documents" &&
                                  a.kind === "document") ||
                                (assetFilter === "Shared" &&
                                  p.sharedAssetIds.includes(a.id))
                              );
                            })
                            .map((a) => (
                              <ActionMenu key={a.id} label={a.name + ' actions'} actions={assetActions(a)}><article tabIndex={0} aria-label={'Asset: ' + a.name}
                                className={
                                  "asset-card " +
                                  (stage === "characters"
                                    ? "character-asset"
                                    : "")
                                }
                                key={a.id}
                              >
                                <button
                                  className="asset-image"
                                  onClick={() => setSelectedAsset(a.id)}
                                >
                                  <Media asset={a} />
                                  <span className="asset-kind">
                                    {a.category}{a.soulIdentityId ? ' · Soul ID' : ''}
                                  </span>
                                  <span className="asset-v">v{a.version}</span>
                                  {p.sharedAssetIds.includes(a.id) && (
                                    <span className="shared-corner">
                                      <Globe2 size={13} />
                                    </span>
                                  )}
                                </button>
                                <div className="asset-info">
                                  <div>
                                    <h3>{a.name}</h3>
                                    <span
                                      className={"status " + statusClass(a)}
                                    >
                                      {a.status}
                                    </span>
                                  </div>
                                  <p>{a.description}</p>
                                  <div className="asset-actions">
                                    <ActionDropdown label={'Actions for ' + a.name} actions={assetActions(a)}/>
                                    <button
                                      onClick={() =>
                                        addNode(
                                          a.category === "Character"
                                            ? "character"
                                            : a.category === "Environment" ||
                                                a.category === "Element"
                                              ? "element"
                                              : "scene",
                                          a.id,
                                        )
                                      }
                                    >
                                      <Plus size={13} />
                                      To canvas
                                    </button>
                                    {["image", "video"].includes(a.kind) && (
                                      <button onClick={() => addToSequence(a)}>
                                        <Film size={13} />
                                        To sequence
                                      </button>
                                    )}
                                    <IconButton
                                      label={"Edit " + a.name}
                                      onClick={() => setSelectedAsset(a.id)}
                                    >
                                      <ArrowUpRight size={15} />
                                    </IconButton>
                                  </div>
                                </div>
                              </article></ActionMenu>
                            ))}
                          <button
                            className="upload-tile"
                            onClick={() =>
                              pickUpload(
                                stage === "characters"
                                  ? "Character"
                                  : stage === "elements"
                                    ? "Element"
                                    : "Reference",
                              )
                            }
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              void uploadFiles(
                                e.dataTransfer.files,
                                stage === "characters"
                                  ? "Character"
                                  : stage === "elements"
                                    ? "Element"
                                    : "Reference",
                              );
                            }}
                          >
                            <Plus size={28} />
                            <strong>
                              {stage === "characters"
                                ? "Add a character"
                                : stage === "elements"
                                  ? "Add an element"
                                  : "Add a reference"}
                            </strong>
                            <span>Drop files or choose from your device</span>
                            <small>
                              Images, video, audio, PDF · large files supported
                            </small>
                          </button>
                        </div>
                        {stage === "characters" &&
                          p.assets.some((a) => a.id === "character") && (
                            <div className="continuity-note">
                              <Info size={18} />
                              <div>
                                <strong>
                                  A continuity note, not a roadblock.
                                </strong>
                                <p>
                                  The sample character’s inner layer differs
                                  from the hero frame. Make a new wardrobe
                                  version when you’re ready; your other work can
                                  continue.
                                </p>
                              </div>
                              <button
                                onClick={() =>
                                  void runGenie(
                                    "Check the character wardrobe continuity across the sample takes",
                                  )
                                }
                              >
                                Ask Atomik
                                <ArrowUpRight size={14} />
                              </button>
                            </div>
                          )}
                      </div>
                    )}
                    {stage === "edit" && (
                      <div className="edit-workspace" data-edit-tab={editInspector}>
                        <div className="edit-topline">
                          <div>
                            <span className="small-tag">ASSEMBLY 01</span>
                            <span className="muted">
                              {p.shots.length} shots · {p.fps} fps · Timeline preview
                            </span>
                          </div>
                          <Button
                            className="btn"
                            variant="outline"
                            onClick={() => setStage("assets")}
                          >
                            <Plus size={14} />
                            Add media
                          </Button>
                        </div>
                        <div className="edit-upper">
                          <div className="edit-player">
                            <div className="player-screen">
                              {currentShot.shot && (
                                <TimelinePreview
                                  key={currentShot.shot.id}
                                  asset={assetsById.get(currentShot.shot.assetId)}
                                  seconds={(currentShot.shot.sourceIn + frame - currentShot.start) / p.fps}
                                  playing={playing}
                                  grade={p.colorGrade}
                                  lut={colorLutAsset(p)}
                                />
                              )}
                              <span className="player-slug">
                                {currentShot.shot?.name || "Your sequence"}
                              </span>
                              <span className="player-tc">
                                {timecode(frame, p.fps)}
                              </span>
                              {!p.shots.length && (
                                <div className="player-empty">
                                  Add your first shot from Assets & takes.
                                </div>
                              )}
                            </div>
                            <div className="player-controls">
                              <div>
                                <IconButton
                                  label="Return to start"
                                  onClick={() => {
                                    setPlaying(false);
                                    setFrame(0);
                                  }}
                                >
                                  <SkipBack size={15} />
                                </IconButton>
                                <IconButton
                                  label={playing ? "Pause" : "Play timeline"}
                                  onClick={() => {
                                    if (frame >= totalFrames - 1) setFrame(0);
                                    setPlaying((v) => !v);
                                  }}
                                  disabled={!totalFrames}
                                >
                                  {playing ? (
                                    <Pause size={18} />
                                  ) : (
                                    <Play size={18} />
                                  )}
                                </IconButton>
                                <span>
                                  {timecode(frame, p.fps)}
                                  <em>/ {timecode(totalFrames, p.fps)}</em>
                                </span>
                              </div>
                              <div>
                                <IconButton
                                  label="Previous frame"
                                  onClick={() => {
                                    setPlaying(false);
                                    setFrame((f) => Math.max(0, f - 1));
                                  }}
                                >
                                  <ArrowLeft size={14} />
                                </IconButton>
                                <IconButton
                                  label="Next frame"
                                  onClick={() => {
                                    setPlaying(false);
                                    setFrame((f) =>
                                      Math.min(
                                        Math.max(0, totalFrames - 1),
                                        f + 1,
                                      ),
                                    );
                                  }}
                                >
                                  <ArrowRight size={14} />
                                </IconButton>
                                <span>{p.aspect}</span>
                              </div>
                            </div>
                          </div>
                          <aside className={colorStyles.inspector} aria-label="Edit inspector">
                            <div className={colorStyles.tabs} role="group" aria-label="Inspector view"><button aria-pressed={editInspector==='shot'} onClick={()=>setEditInspector('shot')}>{mobile?'Shot':'Shot details'}</button><button aria-pressed={editInspector==='color'} onClick={()=>setEditInspector('color')}>{mobile?'Color':'Sequence color'}</button><button aria-pressed={editInspector==='versions'} onClick={()=>setEditInspector('versions')}>{mobile?'Versions':'Edit versions'}</button>{mobile&&<button aria-pressed={editInspector==='sound'} onClick={()=>setEditInspector('sound')}>Sound</button>}</div>
                            {mobile&&editInspector==='sound' ? null : editInspector==='versions' ? <EditVersions key={p.id+storageKey} draftId={p.id} apiBase={apiBase} requestScope={storageKey} onSave={saveNamedEdit} onRestore={restoreNamedEdit}/> : editInspector==='color' ? <SequenceColor key={p.id+storageKey} project={p} onChange={change} onImport={importSequenceLut}/> :
                          <div className="shot-inspector">
                            <div className="eyebrow">SHOT DETAILS</div>
                            {activeShot ? (
                              <>
                                <h3>{activeShot.name}</h3>
                                <label
                                  className="field-label"
                                  htmlFor="shot-duration"
                                >
                                  Duration · seconds
                                </label>
                                <input
                                  id="shot-duration"
                                  type="number"
                                  min={1 / p.fps}
                                  max={900}
                                  step={1 / p.fps}
                                  value={Number(
                                    (activeShot.duration / p.fps).toFixed(3),
                                  )}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n) && n > 0)
                                      setField(
                                        "shots",
                                        p.shots.map((s) =>
                                          s.id === activeShot.id
                                            ? {
                                                ...s,
                                                duration: Math.max(
                                                  1,
                                                  Math.round(n * p.fps),
                                                ),
                                              }
                                            : s,
                                        ),
                                      );
                                  }}
                                />
                                <label
                                  className="field-label"
                                  htmlFor="source-in"
                                >
                                  Source in · frames
                                </label>
                                <input
                                  id="source-in"
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={activeShot.sourceIn}
                                  onChange={(e) =>
                                    setField(
                                      "shots",
                                      p.shots.map((s) =>
                                        s.id === activeShot.id
                                          ? {
                                              ...s,
                                              sourceIn: Math.max(
                                                0,
                                                Math.floor(
                                                  Number(e.target.value) || 0,
                                                ),
                                              ),
                                            }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                                <label
                                  className="field-label"
                                  htmlFor="shot-note"
                                >
                                  Direction
                                </label>
                                <textarea
                                  id="shot-note"
                                  value={activeShot.note}
                                  onChange={(e) =>
                                    setField(
                                      "shots",
                                      p.shots.map((s) =>
                                        s.id === activeShot.id
                                          ? { ...s, note: e.target.value }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                                <div className="shot-actions">
                                  <IconButton
                                    label="Move shot earlier"
                                    onClick={() => moveShot(activeShot.id, -1)}
                                  >
                                    <MoveUp size={15} />
                                  </IconButton>
                                  <IconButton
                                    label="Move shot later"
                                    onClick={() => moveShot(activeShot.id, 1)}
                                  >
                                    <MoveDown size={15} />
                                  </IconButton>
                                  <Button
                                    className="btn"
                                    variant="outline"
                                    onClick={() =>
                                      setSelectedAsset(activeShot.assetId)
                                    }
                                  >
                                    Edit asset
                                    <ArrowUpRight size={13} />
                                  </Button>
                                </div>
                                <button
                                  className="text-danger"
                                  onClick={() => {
                                    setField(
                                      "shots",
                                      p.shots.filter(
                                        (s) => s.id !== activeShot.id,
                                      ),
                                    );
                                    setFrame(0);
                                    setPlaying(false);
                                  }}
                                >
                                  Remove from sequence
                                </button>
                              </>
                            ) : (
                              <p>Select a shot to edit timing and direction.</p>
                            )}
                          </div>}
                          </aside>
                        </div>
                        <div className="timeline">
                          <div className="timeline-title">
                            <div>
                              <Film size={16} />
                              <strong>Main sequence</strong>
                              <span>{timecode(totalFrames, p.fps)}</span>
                            </div>
                            <span>Drag clips to reorder</span>
                          </div>
                          <Slider
                            className="scrub-slider"
                            aria-label="Sequence playhead"
                            value={[frame]}
                            min={0}
                            max={Math.max(totalFrames - 1, 1)}
                            step={1}
                            onValueChange={(v) => {
                              setPlaying(false);
                              setFrame(v[0]);
                            }}
                          />
                          <div className="timeline-ruler">
                            <span>00:00</span>
                            <span>
                              {timecode(
                                Math.round(totalFrames / 3),
                                p.fps,
                              ).slice(3, 8)}
                            </span>
                            <span>
                              {timecode(
                                Math.round((totalFrames * 2) / 3),
                                p.fps,
                              ).slice(3, 8)}
                            </span>
                            <span>
                              {timecode(totalFrames, p.fps).slice(3, 8)}
                            </span>
                          </div>
                          <div className="video-lane">
                            <div className="track-label">
                              V1
                              <Film size={13} />
                            </div>
                            <div className="timeline-clips">
                              {p.shots.map((s) => (
                                <button
                                  key={s.id}
                                  draggable
                                  className={
                                    "timeline-clip " +
                                    (activeShot?.id === s.id ? "active" : "")
                                  }
                                  style={{ flexGrow: s.duration, flexBasis: 0 }}
                                  onClick={() => focusShot(s)}
                                  onDragStart={(e) =>
                                    e.dataTransfer.setData(
                                      "text/particl-shot",
                                      s.id,
                                    )
                                  }
                                  onDragOver={(e) => e.preventDefault()}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    const id =
                                      e.dataTransfer.getData(
                                        "text/particl-shot",
                                      );
                                    if (!id || id === s.id) return;
                                    change((old) => {
                                      const arr = [...old.shots];
                                      const item = arr.find((x) => x.id === id);
                                      if (!item) return old;
                                      const rest = arr.filter(
                                        (x) => x.id !== id,
                                      );
                                      rest.splice(
                                        rest.findIndex((x) => x.id === s.id),
                                        0,
                                        item,
                                      );
                                      return { ...old, shots: rest };
                                    });
                                  }}
                                >
                                  <Media asset={assetsById.get(s.assetId)} />
                                  <span>{s.name}</span>
                                  <small>
                                    {(s.duration / p.fps).toFixed(1)}s
                                  </small>
                                </button>
                              ))}
                            </div>
                          </div>
                          <div data-mobile-sound-panel style={mobile?undefined:{display:"contents"}}><SoundMix key={p.id+storageKey} project={p} frame={frame} playing={playing} onChange={change} onPause={()=>setPlaying(false)} onUpload={()=>pickUpload('Audio')}/></div>
                        </div>
                      </div>
                    )}
                    {stage === "export" && (
                      <div className="stage-scroll">
                        <div className="delivery-grid">
                          <div className="delivery-main">
                            <section className="movie-export"><h3>Final movie</h3><p>Render the selected takes and sound into a downloadable MP4 or WebM, on this device.</p><button className="btn primary large" onClick={()=>{try{const path=createMovieHandoff(pRef.current,storageKey);void leaveWorkspace(path);}catch(error){toast.error(error instanceof Error?error.message:'This browser cannot prepare the export.');}}}>Open movie renderer</button><p className="movie-limit">Up to 3 minutes · 720p or 1080p · no generation credits</p></section>
                            <span className="eyebrow">
                              THE EDITORIAL HANDOFF
                            </span>
                            <h2>Ready for the next room.</h2>
                            <p>
                              Take the sequence, selected source files and
                              project context into your edit.
                            </p>
                            <div className="export-options">
                              <label className="export-option">
                                <span className="export-icon">
                                  <Clapperboard />
                                </span>
                                <span>
                                  <strong>Editorial package</strong>
                                  <small>
                                    CMX3600 EDL, source media, shot list and
                                    provenance
                                  </small>
                                </span>
                                <Check size={18} />
                              </label>
                              <div className="export-settings">
                                <div>
                                  <span className="field-label">
                                    Frame rate
                                  </span>
                                  <Choice
                                    label="Export frame rate"
                                    value={String(p.fps)}
                                    options={["24", "25", "30"]}
                                    onChange={(v) => {
                                      const fps = Number(v);
                                      change((old) => ({
                                        ...old,
                                        fps,
                                        audioAssetId: undefined,
                                        audioClips: audioClips(old).map(clip=>({...clip,
                                          startFrame:Math.round(clip.startFrame / old.fps * fps),sourceIn:Math.round(clip.sourceIn / old.fps * fps),duration:Math.max(1,Math.round(clip.duration / old.fps * fps)),fadeIn:Math.floor(clip.fadeIn / old.fps * fps),fadeOut:Math.floor(clip.fadeOut / old.fps * fps)
                                        })),
                                        shots: old.shots.map((s) => ({
                                          ...s,
                                          duration: Math.max(
                                            1,
                                            Math.round(
                                              (s.duration / old.fps) * fps,
                                            ),
                                          ),
                                          sourceIn: Math.round(
                                            (s.sourceIn / old.fps) * fps,
                                          ),
                                        })),
                                      }));
                                      setFrame(0);
                                      setPlaying(false);
                                    }}
                                  />
                                </div>
                                <div>
                                  <span className="field-label">
                                    Aspect ratio
                                  </span>
                                  <Choice
                                    label="Delivery aspect ratio"
                                    value={p.aspect}
                                    options={["16:9", "9:16", "1:1", "4:5"]}
                                    onChange={(v) => setField("aspect", v)}
                                  />
                                </div>
                                <div>
                                  <span className="field-label">
                                    Record start
                                  </span>
                                  <span className="fixed-value">
                                    01:00:00:00
                                  </span>
                                </div>
                              </div>
                              <div className="delivery-checks">
                                <div>
                                  <Check size={15} />
                                  <span>{p.shots.length} sequence events</span>
                                </div>
                                <div>
                                  <Check size={15} />
                                  <span>
                                    Frame-accurate durations · non-drop frame
                                  </span>
                                </div>
                                <div>
                                  <Info size={15} />
                                  <span>
                                    Source media must match the chosen frame
                                    rate. Aspect ratio is a delivery note, not a
                                    reframe.
                                  </span>
                                </div>
                                <div>
                                  <Info size={15} />
                                  <span>
                                    EDL carries straight cuts on V1. Audio,
                                    crop, colour and generative edits stay in
                                    the manifest. Relink stills as holds in your
                                    editor.
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="export-button-row">
                              <Button
                                className="btn primary large"
                                disabled={exporting || !p.shots.length}
                                onClick={async () => {
                                  setExporting(true);
                                  try {
                                    await exportPackage(p);
                                    toast.success(
                                      "Editorial package downloaded",
                                    );
                                  } catch (e) {
                                    toast.error(
                                      e instanceof Error
                                        ? e.message
                                        : "Could not export.",
                                    );
                                  } finally {
                                    setExporting(false);
                                  }
                                }}
                              >
                                {exporting ? (
                                  <Loader2 className="spin" size={17} />
                                ) : (
                                  <Download size={17} />
                                )}
                                Download package
                                <ArrowUpRight size={15} />
                              </Button>
                              <button
                                disabled={!p.shots.length}
                                onClick={()=>{try{downloadFile(new Blob([makeEDL(p)],{type:'text/plain'}),safeName(p.name)+'.edl')}catch(e){toast.error(e instanceof Error?e.message:'Could not export EDL.')}}}
                              >
                                EDL only
                              </button>
                            </div>
                          </div>
                          <div className="delivery-preview">
                            <div className="delivery-thumb">
                              <Media
                                asset={p.assets.find(
                                  (a) => a.id === p.shots[0]?.assetId,
                                )}
                              />
                              <span>{p.name}</span>
                            </div>
                            <div className="package-facts">
                              <div>
                                <span>Sequence</span>
                                <strong>Assembly 01</strong>
                              </div>
                              <div>
                                <span>Runtime</span>
                                <strong>
                                  {(totalFrames / p.fps).toFixed(2)} seconds
                                </strong>
                              </div>
                              <div>
                                <span>Events</span>
                                <strong>{p.shots.length} shots</strong>
                              </div>
                              <div>
                                <span>Source media</span>
                                <strong>
                                  {new Set(p.shots.map((s) => s.assetId)).size}{" "}
                                  assets
                                </strong>
                              </div>
                              <div>
                                <span>Take lineage</span>
                                <strong>Included in manifest</strong>
                              </div>
                            </div>
                            <div className="export-file-list">
                              <FileText size={15} />
                              sequence.edl
                              <br />
                              <FileText size={15} />
                              shotlist.csv
                              <br />
                              <FileText size={15} />
                              production.json
                              <br />
                              <FolderOpen size={15} />
                              media/
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
              {!mobile&&!atomOpen&&<button className="suite-atomik-collapse" aria-label="Open Atomik" onClick={()=>setAtomOpen(true)}><AtomMark/><span>Atomik</span></button>}
              <MobilePanel
                mobile={mobile}
                open={atomOpen}
                onOpenChange={setAtomOpen}
                title="Atomik"
                description={mobile?`Creative engine · ${p.name} · ⌘J`:"Your creative crew, in reach."}
                kind="atomik"
                style={atomikSize.style}
              >
                <aside
                  className="atomik-panel"
                  id="atomik-panel"
                  aria-label="Atomik creative engine"
                >
                  <AtomikResizer size={atomikSize}/>
                  <div className="atomik-heading">
                    <div>
                      <span className="atomik-symbol">
                        <AtomMark />
                      </span>
                      <span>
                        <strong>Atomik</strong>
                        <small>YOUR CREATIVE ENGINE</small>
                      </span>
                    </div>
                    <IconButton
                      label="Collapse Atomik"
                      onClick={() => setAtomOpen(false)}
                    >
                      <PanelRightClose size={17} />
                    </IconButton>
                  </div>
                  <Tabs value={atomTab} onValueChange={value=>{setAtomTab(value);atomMessages.current?.scrollTo({top:0});}}>
                    <TabsList className={`atomik-tabs ${marketingStyles.tabs}`}>
                      <TabsTrigger value="genie">Genie</TabsTrigger>
                      <TabsTrigger value="marketing">Marketing</TabsTrigger>
                      <TabsTrigger value="crew">Crew</TabsTrigger>
                      <TabsTrigger value="context">
                        Context
                        <span className="count">{contextIds.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="runs">
                        Activity<span className="count">{p.plans.length}</span>
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <div className="atomik-content" ref={atomMessages}>
                    {atomTab === 'marketing' && renderMarketingPanel()}
                    {atomTab === "genie" && (
                      <>
                        {!p.plans.length && (
                          <>
                            <div className="genie-intro">
                              <span className="tiny-orbit">
                                <AtomMark />
                              </span>
                              <h2>{mobile ? "Ask Atomik" : <>A little spark.<br />A whole new world.</>}</h2>
                              <p>
                                {mobile ? "Plans before it spends. Every run is priced first and lands in your space, never the shared bible." : "Bring the idea. I’ll help you shape the campaign, connect the references and build the canvas."}
                              </p>
                            </div>
                            <div className="context-summary">
                              <GitBranch size={14} />
                              <span>{p.name}</span>
                              <small>Project context</small>
                            </div>
                            <div className="starter-prompts">
                              {[
                                {
                                  icon: Sparkles,
                                  title: "Find the campaign idea",
                                  sub: "A thought into a creative direction",
                                  q: "Develop a campaign from my production brief",
                                },
                                {
                                  icon: Clapperboard,
                                  title: "Build a shot sequence",
                                  sub: "Turn the story into filmable moments",
                                  q: "Build a three-shot sequence for this campaign",
                                },
                                {
                                  icon: Scan,
                                  title: "Check visual continuity",
                                  sub: "Keep characters and worlds coherent",
                                  q: "Check character and wardrobe continuity",
                                },
                              ].map((item) => (
                                <button
                                  key={item.title}
                                  onClick={() => void runGenie(item.q)}
                                >
                                  <item.icon size={17} />
                                  <span>
                                    {item.title}
                                    <small>{item.sub}</small>
                                  </span>
                                  <ArrowUpRight size={14} />
                                </button>
                              ))}
                            </div>
                            <div className="engine-note">
                              <GitBranch size={14} />
                              <span>
                                Everything starts in your space.
                                <br />
                                Share the parts you want to bring together.
                              </span>
                            </div>
                          </>
                        )}
                        {p.plans.map((plan) => (
                          <div className="chat-exchange" key={plan.id}>
                            <div className="user-message">{plan.request}</div>
                            <div className="agent-message">
                              <div className="agent-byline">
                                <AtomMark />
                                <strong>{plan.role || "Atomik"}</strong>
                                <small>Project plan</small>
                              </div>
                              <p>{plan.summary}</p>
                              <div className="plan-steps">
                                {plan.steps.map((step, i) => (
                                  <div key={i}>
                                    <span>
                                      {String(i + 1).padStart(2, "0")}
                                    </span>
                                    <p>{step}</p>
                                  </div>
                                ))}
                              </div>
                              <Button
                                className={
                                  "btn " +
                                  (plan.applied ? "applied" : "primary")
                                }
                                disabled={plan.applied}
                                onClick={() => applyPlan(plan)}
                              >
                                {plan.applied ? (
                                  <Check size={15} />
                                ) : (
                                  <GitBranch size={15} />
                                )}{" "}
                                {plan.applied
                                  ? "Added to your space"
                                  : "Build in my space"}
                              </Button>
                              <span className="plan-meta">
                                {thinkingModelName(plan.model,jobs.models)} · {plan.depth} exploration · Sample
                                workflow
                              </span>
                            </div>
                          </div>
                        ))}
                        {busy && (
                          <div className="agent-working">
                            <Loader2 size={16} className="spin" />
                            Starting Atomik…
                          </div>
                        )}
                      </>
                    )}
                    {atomTab === "crew" && (
                      <CrewPanel
                        project={p}
                        onRun={(role) => exploreCrew(role)}
                        onRunAll={() => exploreCrew()}
                      />
                    )}
                    {atomTab === "context" && (
                      <div className="context-tab">
                        <div className="section-heading">
                          <strong>Project context</strong>
                          <span className="small-tag">Always included</span>
                        </div>
                        <div className="context-brief">
                          <FileText size={17} />
                          <div>
                            <strong>{p.name}</strong>
                            <p>
                              {p.brief.slice(0, 150) ||
                                "Add a brief to give Atomik a starting point."}
                            </p>
                          </div>
                        </div>
                        <div className="section-heading">
                          <strong>References</strong>
                          <button onClick={() => pickUpload()}>
                            <Plus size={16} />
                          </button>
                        </div>
                        {p.assets.map((a) => (
                          <label className="context-asset" key={a.id}>
                            <Checkbox
                              checked={contextIds.includes(a.id)}
                              onCheckedChange={(v) =>
                                setContextIds((old) =>
                                  v
                                    ? [...old, a.id]
                                    : old.filter((id) => id !== a.id),
                                )
                              }
                            />
                            <Media asset={a} />
                            <span>
                              {a.name}
                              <small>
                                {a.category} · v{a.version}
                              </small>
                            </span>
                          </label>
                        ))}
                        <button
                          className="context-link"
                          onClick={() => setDialog("reference")}
                        >
                          <Link2 size={15} />
                          Add a website reference
                        </button>
                        <p className="context-disclosure">
                          Selected descriptions, directions and supported uploaded text are included in Atomik context. Media generation receives bound images and video. Website links remain references; their pages are not fetched automatically.
                        </p>
                      </div>
                    )}
                    {atomTab === "runs" && (
                      <div className="activity-tab">
                        <h3>Your creative activity</h3>
                      {jobs.error&&<p role="status">{jobs.error}</p>}
                      {[...jobs.atomikJobs,...jobs.mediaJobs].map(job=><div className="activity-item" key={job.id}><span className="activity-icon"><Sparkles size={16}/></span><div><strong>{thinkingModelName(job.model,jobs.models)}</strong><p>{job.status}</p>{job.error&&<p role="alert">{job.error}</p>}<small>{'credits' in job && job.credits!=null?job.credits+' cr':''}</small></div><button onClick={()=>void jobs.refresh()} aria-label="Refresh job status"><Undo2 size={14}/></button></div>)}
                        {!p.plans.length ? (
                          <p>Your ideas and canvas actions will appear here.</p>
                        ) : (
                          p.plans.map((plan) => (
                            <div className="activity-item" key={plan.id}>
                              <span className="activity-icon">
                                {plan.applied ? (
                                  <GitBranch size={16} />
                                ) : (
                                  <Sparkles size={16} />
                                )}
                              </span>
                              <div>
                                <strong>
                                  {plan.role ||
                                    (plan.intent === "continuity"
                                      ? "Continuity review"
                                      : plan.intent === "shots"
                                        ? "Shot sequence"
                                        : plan.intent === "revision"
                                          ? "Revision direction"
                                          : "Campaign exploration")}
                                </strong>
                                <p>
                                  {plan.applied
                                    ? "Added to your personal canvas"
                                    : "Ready to explore"}
                                </p>
                                <small>{thinkingModelName(plan.model,jobs.models)}{plan.effort ? ` · ${effortLabel(plan.effort,jobs.models.find(option=>option.id===plan.model))}` : ""}</small>
                              </div>
                              <Check size={13} />
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  {atomTab !== 'marketing' && <div className="atomik-composer">
                    <div className="attached-context">
                      <span>
                        <Paperclip size={12} />
                        {contextIds.length} references
                      </span>
                      <button onClick={() => setAtomTab("context")}>
                        Manage
                        <ChevronRight size={12} />
                      </button>
                    </div>
                    <textarea
                      ref={promptRef}
                      aria-label="Ask Atomik"
                      placeholder="An idea, an edit, a what if…"
                      value={prompt}
                      maxLength={10000}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void runGenie();
                        }
                      }}
                    />
                    <div className="composer-bottom">
                      <div>
                        <IconButton
                          label="Upload references from device"
                          onClick={() => pickUpload()}
                        >
                          <Plus size={17} />
                        </IconButton>
                        <ModelPicker label="Reasoning model" value={model} models={jobs.models} compact
                          onPick={value => { setModel(value); setEffort("auto"); }} />
                      </div>
                      <button
                        className="send-button"
                        aria-label="Run Atomik"
                        disabled={!signedIn || !prompt.trim() || busy}
                        onClick={() => void runGenie()}
                      >
                        {mobile&&<span>Run Atomik</span>}
                        {busy ? (
                          <Loader2 className="spin" size={18} />
                        ) : (
                          <ArrowUp size={18} />
                        )}
                      </button>
                    </div>
                    <div className="atomik-reasoning-controls">
                      <EffortPicker value={effort} model={jobs.models.find(option => option.id === model)} onPick={setEffort} compact />
                      <Choice label="Response detail" value={depth} onChange={setDepth} options={["Quick", "Considered", "Deep"]} />
                    </div>
                  </div>}
                  <button
                    className="demo-disclosure"
                    onClick={() => setDialog("connections")}
                  >
                    <span className="demo-dot" />
                    Connected production engine
                    <Info size={12} />
                  </button>
                </aside>
              </MobilePanel>
            </div>
            <SuiteDock disabled={!hydrated||(signedIn&&initializedScope!==storageKey)||transitioning} suite={suite} activePage={home?undefined:suite==='moleculr'?moleculrPage:stage} projectId={ready?p.id:undefined} onNavigate={path=>leaveWorkspace(path)} onPage={page=>{if(!hydrated||(signedIn&&initializedScope!==storageKey)||transitioning)return;if(suite==='moleculr')setMoleculrPage(page);else setStage(page as Stage)}}/>
            {mobile && suite==='particl' && !home && !welcomeChoice && stage!=='canvas' && <nav className="phone-stage-pager" aria-label="Workflow stages">
              {STAGES.findIndex(s=>s.id===stage)>0 ? <button onClick={()=>setStage(STAGES[STAGES.findIndex(s=>s.id===stage)-1].id)}><ArrowLeft size={14}/><span>{String(STAGES.findIndex(s=>s.id===stage)).padStart(2,'0')} {STAGES[STAGES.findIndex(s=>s.id===stage)-1].label}</span></button> : <button onClick={()=>setMobileWorkflowOpen(true)}><ArrowLeft size={14}/> Workflow</button>}
              {STAGES.findIndex(s=>s.id===stage)<STAGES.length-1 && <button onClick={()=>setStage(STAGES[STAGES.findIndex(s=>s.id===stage)+1].id)}><span>{String(STAGES.findIndex(s=>s.id===stage)+2).padStart(2,'0')} {STAGES[STAGES.findIndex(s=>s.id===stage)+1].label}</span><ArrowRight size={14}/></button>}
            </nav>}
            {mobile&&home ? <nav className="phone-home-dock project-home-dock" aria-label="Project tools"><button disabled={!hydrated||(signedIn&&initializedScope!==storageKey)} onClick={()=>setStage("canvas")}><GitBranch size={20}/>Workflow</button><button disabled={signedIn&&!ready} onClick={()=>void leaveWorkspace("/generate?project="+encodeURIComponent(p.id))}><Scan size={20}/>Gen</button><button disabled={signedIn&&!ready} onClick={()=>void leaveWorkspace("/library?project="+encodeURIComponent(p.id))}><FolderOpen size={20}/>Library</button><button aria-current="page" onClick={()=>setHome(true)}><LayoutGrid size={20}/>Workspace</button></nav> : <MobileNavigation
              workflowOpen={mobileWorkflowOpen}
              onWorkflowOpen={setMobileWorkflowOpen}
              projectDescription={`${p.description} · ${p.aspect} · ${p.fps} fps`}
              actions={<><button onClick={()=>void leaveWorkspace("/generate?project="+encodeURIComponent(p.id))}><Scan size={14}/>Gen</button><button onClick={()=>void leaveWorkspace("/library?project="+encodeURIComponent(p.id))}><FolderOpen size={14}/>Project library</button><button onClick={()=>{setMobileWorkflowOpen(false);setHome(true)}}><LayoutGrid size={14}/>Project workspace</button><button onClick={()=>void leaveWorkspace(`/pipelines${p.productionProjectId?`?projectId=${encodeURIComponent(p.productionProjectId)}`:""}`)}><GitBranch size={14}/>Pipelines</button><button onClick={()=>{setMobileWorkflowOpen(false);setStage('export')}}><Download size={14}/>Export</button><button onClick={()=>void publishBible()}>Publish project bible</button><button onClick={()=>{setMobileWorkflowOpen(false);setDialog('shortcuts')}}>Shortcuts</button><DropdownMenu><DropdownMenuTrigger asChild><button aria-label="Project actions"><MoreHorizontal size={17}/></button></DropdownMenuTrigger><DropdownMenuContent className="ps">
                <DropdownMenuItem onSelect={()=>{setMobileWorkflowOpen(false);setDialog('project')}}><Plus size={14}/>New project</DropdownMenuItem>
                {productions.map(item=><DropdownMenuItem key={'mobile-prod-'+item.id} onSelect={()=>{setMobileWorkflowOpen(false);void openProduction(item.id)}}>Open {item.name} in my space</DropdownMenuItem>)}
                {projects.filter(item=>item.id!==p.id).map(item=><DropdownMenuItem key={'mobile-project-'+item.id} onSelect={()=>{setMobileWorkflowOpen(false);void loadProject(item.id);setStage('canvas')}}>{item.name}</DropdownMenuItem>)}
                <DropdownMenuItem onSelect={()=>downloadFile(new Blob([JSON.stringify(p,null,2)],{type:'application/json'}),safeName(p.name)+'.json')}>Download project data</DropdownMenuItem>
                <DropdownMenuItem onSelect={()=>{setMobileWorkflowOpen(false);setDialog('connections')}}>Connected engines</DropdownMenuItem>
                <DropdownMenuItem onSelect={()=>{setMobileWorkflowOpen(false);setDialog('review')}}>Studio guide</DropdownMenuItem>
                {!sourceMode&&<DropdownMenuItem asChild><a href="/particl-redesign-source.zip" download>Download redesigned repository</a></DropdownMenuItem>}
              </DropdownMenuContent></DropdownMenu><MobileStudioMenu projectId={ready?p.id:undefined} active="studio" initialAccount={initialAccount} onNavigate={path=>leaveWorkspace(path)} onSwitch={id=>leaveWorkspace('/workbench',{kind:'switch',id})} onSignOut={()=>leaveWorkspace('/login',{kind:'logout'})}/></>}
              disabled={!hydrated||(signedIn&&initializedScope!==storageKey)||transitioning}
              home={home}
              stage={stage}
              projectName={p.name}
              onHome={() => {
                setHome(true);
                setAtomOpen(false);
              }}
              onStage={setStage}
            />}
          </main>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,text/plain"
          className="hidden"
          aria-label="Upload project files"
          onChange={(e) => void uploadFiles(e.target.files)}
        />
        <Dialog
          open={!!dialog}
          onOpenChange={(v) => {
            if (!v) {
              setDialog(null);
              setEditingNode(null);
              setNodeName("");
            }
          }}
        >
          <DialogContent
            className={
              "ps ps-dialog " + (dialog === "review" ? "review-dialog" : "")
            }
          >
            <DialogHeader>
              <DialogTitle>
                {dialog === "project"
                  ? "A new project"
                  : dialog === "node"
                    ? "Add to your canvas"
                    : dialog === "reference"
                      ? "Add a reference"
                      : dialog === "shortcuts"
                        ? "A faster way to work"
                        : dialog === "review"
                          ? "Particl / studio guide"
                          : "Production connections"}
              </DialogTitle>
              <DialogDescription>
                {dialog === "project"
                  ? "Start with a name. There’s room for everything else."
                  : dialog === "node"
                    ? "A building block for your own creative space."
                    : dialog === "reference"
                      ? "Bring in a file or keep a website link with the project."
                      : dialog === "review"
                        ? "From brief and references to takes and delivery."
                        : dialog === "shortcuts"
                          ? "Keep your attention on the work."
                          : "What works here, and what connects to the production platform."}
              </DialogDescription>
            </DialogHeader>
            {dialog === "project" && (
              <div className="dialog-fields">
                <label className="field-label" htmlFor="new-production">
                  Project name
                </label>
                <input
                  id="new-production"
                  autoFocus
                  value={newName}
                  maxLength={100}
                  placeholder="Name your next project"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && void createProduction()
                  }
                />
                <Button
                  className="btn primary"
                  disabled={!newName.trim()}
                  onClick={() => void createProduction()}
                >
                  Create project
                  <ArrowRight size={15} />
                </Button>
              </div>
            )}
            {dialog === "node" && (
              <div className="dialog-fields">
                <div className="node-kind-grid">
                  {[
                    "Scene",
                    "Moodboard",
                    "Character",
                    "Element",
                    "Note",
                    "Brief",
                  ].map((k) => {
                    const Icon =
                      nodeIcons[k.toLowerCase() as keyof typeof nodeIcons];
                    return (
                      <button
                        className={nodeKind === k ? "active" : ""}
                        onClick={() => setNodeKind(k)}
                        key={k}
                      >
                        <Icon size={20} />
                        {k}
                      </button>
                    );
                  })}
                </div>
                <label className="field-label" htmlFor="node-title">
                  Title or note
                </label>
                <textarea
                  id="node-title"
                  placeholder="What belongs here?"
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                />
                {editingNode && (
                  <div className="node-bindings">
                    <span className="field-label">Source asset</span>
                    <Select
                      value={
                        p.nodes.find((n) => n.id === editingNode)?.assetId ||
                        "none"
                      }
                      onValueChange={(id) =>
                        change((old) => ({
                          ...old,
                          nodes: old.nodes.map((n) =>
                            n.id === editingNode
                              ? {
                                  ...n,
                                  assetId: id === "none" ? undefined : id,
                                }
                              : n,
                          ),
                        }))
                      }
                    >
                      <SelectTrigger
                        aria-label="Node source asset"
                        className="choice"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="ps">
                        <SelectItem value="none">No source yet</SelectItem>
                        {p.assets.map((a) => (
                          <SelectItem value={a.id} key={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="field-label">Connect references from</span>
                    {p.nodes
                      .filter((n) => n.id !== editingNode)
                      .map((n) => (
                        <label className="node-binding-row" key={n.id}>
                          <Checkbox
                            checked={
                              p.nodes
                                .find((x) => x.id === editingNode)
                                ?.linked.includes(n.id) || false
                            }
                            onCheckedChange={(v) =>
                              change((old) => ({
                                ...old,
                                nodes: old.nodes.map((x) =>
                                  x.id === editingNode
                                    ? {
                                        ...x,
                                        linked: v
                                          ? [...new Set([...x.linked, n.id])]
                                          : x.linked.filter(
                                              (id) => id !== n.id,
                                            ),
                                      }
                                    : x,
                                ),
                              }))
                            }
                          />
                          {n.title}
                        </label>
                      ))}
                  </div>
                )}
                <Button
                  className="btn primary"
                  onClick={() => {
                    const type = nodeKind.toLowerCase() as CanvasNode["type"];
                    if (editingNode) {
                      change((old) => ({
                        ...old,
                        nodes: old.nodes.map((n) =>
                          n.id === editingNode
                            ? { ...n, type, text: nodeName }
                            : n,
                        ),
                      }));
                      setEditingNode(null);
                      setDialog(null);
                    } else addNode(type, undefined, nodeName || undefined);
                    setNodeName("");
                  }}
                >
                  <Plus size={15} />
                  {editingNode ? "Save node" : "Add to my space"}
                </Button>
              </div>
            )}
            {dialog === "reference" && (
              <div className="dialog-fields">
                <button className="dialog-upload" onClick={() => pickUpload()}>
                  <Upload size={25} />
                  <strong>Upload from your device</strong>
                  <span>
                    Images, video, audio, PDF and text · large files supported
                  </span>
                </button>
                <span className="or-label">OR ADD A WEBSITE</span>
                <input
                  aria-label="Reference website URL"
                  type="url"
                  placeholder="https://…"
                  value={referenceUrl}
                  onChange={(e) => setReferenceUrl(e.target.value)}
                />
                <p className="muted small-copy">
                  Links are kept with the project. Website content is not
                  fetched automatically.
                </p>
                <Button
                  className="btn primary"
                  disabled={!referenceUrl.trim()}
                  onClick={addLink}
                >
                  Add reference
                  <Link2 size={15} />
                </Button>
              </div>
            )}
            {dialog === "shortcuts" && (
              <div className="shortcut-list">
                {[
                  ["Open / close Atomik", "⌘ / Ctrl + J"],
                  ["Undo", "⌘ / Ctrl + Z"],
                  ["Redo", "⌘ / Ctrl + Shift + Z"],
                  ["Fit canvas", "⌘ / Ctrl + 0"],
                  ["Run Atomik", "⌘ / Ctrl + Enter"],
                  ["Play / pause in Edit", "Space"],
                  ["Show shortcuts", "?"],
                ].map(([a, b]) => (
                  <div key={a}>
                    <span>{a}</span>
                    <kbd>{b}</kbd>
                  </div>
                ))}
              </div>
            )}
            {dialog === "connections" && <div className="connection-info"><p>These models are available for Atomik. Choose an image or video engine when generating a take.</p><div className="provider-list">{jobs.models.length?jobs.models.map(m=><div key={m.id}><span>{m.name}</span><small>Available</small></div>):<p>Sign in to view configured reasoning models.</p>}</div><p>Canvas edits, private versions, shared project bibles, source uploads, sequence timing and exports are saved in your workspace. Website links are references; arbitrary website content is not automatically fetched. Delivery renders a synchronized final movie on your device, or exports original media and an EDL. Target-NLE conform validation remains separate.</p><button type="button" onClick={()=>void leaveWorkspace("/settings")}>Workspace settings</button></div>}
            {dialog === "review" && <DesignReview />}
          </DialogContent>
        </Dialog>
        {binAssetId&&p.assets.some(a=>a.id===binAssetId)&&<AssetBinPicker project={p} asset={p.assets.find(a=>a.id===binAssetId)!} onChange={change} onClose={()=>setBinAssetId(null)}/>}
      {selected && (
          <AssetEditor
            key={selected.id}
            asset={selected}
            project={p}
            requestScope={storageKey}
            apiBase={apiBase}
            onClose={() => setSelectedAsset(null)}
            onUpdate={(fields) => {if(pRef.current.id===p.id)updateAsset(selected.id, fields);}}
            onShare={() => {void publishAsset(selected.id);}}
            onSequence={() => addToSequence(selected)}
            onNewAsset={(a) => {
              if(pRef.current.id!==p.id||transitioningRef.current)return;
              change((old) => ({
                ...old,
                assets: [...old.assets, a],
                nodes: [
                  ...old.nodes,
                  {
                    id: uid("node"),
                    title: a.name,
                    type: "scene",
                    assetId: a.id,
                    x: 905,
                    y: 590,
                    width: 360,
                    linked: p.nodes
                      .filter((n) => n.assetId === selected.id)
                      .map((n) => n.id),
                  },
                ],
              }));
              setSelectedAsset(a.id);
              toast.success("New take saved. The original stays intact.");
            }}
          />
        )}
        {soulTarget&&soulTarget.draftId===p.id&&<SoulIdentityPanel key={storageKey+p.id+soulTarget.subjectType+(soulTarget.assetId??'')} project={p} scope={storageKey} enabled={signedIn&&ready&&!transitioning} subjectType={soulTarget.subjectType} assetId={soulTarget.assetId} onClose={()=>setSoulTarget(null)} onSettings={()=>void leaveWorkspace('/settings#engines')} onSave={()=>ensureSaved(soulTarget.draftId)} onUpload={files=>uploadFiles(files,soulTarget.subjectType==='character'?'Character':'Element')} onAttach={async(identity,assetId)=>{
          if(pRef.current.id!==soulTarget.draftId||transitioningRef.current)throw new Error('Return to the original project before attaching this Soul ID.');
          const category=soulTarget.subjectType==='character'?'Character':'Element';
          const alreadyAttached=!assetId&&pRef.current.assets.find(asset=>asset.soulIdentityId===identity.id&&asset.category===category);
          if(!alreadyAttached){const asset=soulIdentityAsset(pRef.current,identity,category,assetId);change(previous=>({...previous,assets:assetId?previous.assets.map(existing=>existing.id===assetId?asset:existing):[...previous.assets,asset]}));}
          if(!await ensureSaved(soulTarget.draftId))throw new Error('The Soul ID is attached on screen. Save this project before leaving to retain the binding.');
          toast.success('Soul ID attached. Its original portrait is available on the canvas.');
        }}/>}
        {generationTarget&&generationTarget.draftId===p.id&&<GenerationDialog scope={storageKey} target={generationTarget} project={p} onClose={()=>setGenerationTarget(null)} onSave={()=>ensureSaved(generationTarget.draftId)} onAsset={(id,fields)=>{if(pRef.current.id===generationTarget.draftId)updateAsset(id,fields);}} onQueued={(_id,kind)=>{if(pRef.current.id!==generationTarget.draftId)return;if(kind)change(old=>({...old,nodes:old.nodes.map(node=>node.id===generationTarget.node.id&&!node.locked?{...node,mode:kind==='audio'?'Audio':kind==='video'?'Video':'Image'}:node)}));void ensureSaved(generationTarget.draftId,true).then(saved=>{if(saved)void jobs.refresh();});setAtomOpen(true);setAtomTab('runs');toast.success('Generation submitted. Follow its progress in Activity.');}}/>}
        {atomikTarget&&atomikTarget.draftId===p.id&&<AtomikRunDialog scope={storageKey} target={atomikTarget} project={p} models={jobs.models} onSave={()=>ensureSaved(atomikTarget.draftId)} onClose={()=>setAtomikTarget(null)} onQueued={()=>{if(pRef.current.id!==atomikTarget.draftId)return;setPrompt('');setAtomOpen(true);setAtomTab('runs');void jobs.refresh();toast.success(atomikTarget.role==='marketing'?'Atomik started. Campaign outputs are saved in Marketing.':'Atomik started. Results are saved in Genie.');}}/>}
      <Toaster theme="dark" position="bottom-center" />
      </div>
    </TooltipProvider>
  );
}

function AssetEditor({
  asset: a,
  project: p,
  requestScope,
  apiBase,
  onClose,
  onUpdate,
  onShare,
  onSequence,
  onNewAsset,
}: {
  asset: Asset;
  project: Project;
  requestScope: string;
  apiBase: string;
  onClose: () => void;
  onUpdate: (p: Partial<Asset>) => void;
  onShare: () => void;
  onSequence: () => void;
  onNewAsset: (a: Asset) => void;
}) {
  const [edits, setEdits] = useState<EditSettings>(defaultEdits);
  const [compare, setCompare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("Adjust");
  const filter = `brightness(${edits.exposure}%) contrast(${edits.contrast}%) saturate(${edits.saturation}%)`;
  async function saveTake() {
    setSaving(true);
    try {
      const blob = await renderImage(a.url, edits);
      const data=await uploadWorkbench(new File([blob],safeName(a.name)+'-edit.png',{type:'image/png'}),undefined,requestScope);
      onNewAsset({
        ...a,
        id: data.id,
        uploadId:data.id,
        generationId:undefined,
        soulIdentityId:undefined,
        url: data.url,
        name: a.name.replace(/ · edit \d+$/, "") + " · edit " + (a.version + 1),
        version: a.version + 1,
        parentId: a.id,
        locked: false,
        status: "Draft",
        mime: "image/png",
        description: `${edits.ratio} · Brightness ${edits.exposure}% · Contrast ${edits.contrast}% · Saturation ${edits.saturation}%`,
        refs: [a.id, ...a.refs],
      });
      setEdits(defaultEdits);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save this edit.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="ps asset-editor-dialog">
        <DialogHeader>
          <DialogTitle>
            {a.name}
            <span className="small-tag">v{a.version}</span>
          </DialogTitle>
          <DialogDescription>
            {a.category} ·{" "}
            {a.kind === "image"
              ? "Non-destructive image editing"
              : "Project asset"}
          </DialogDescription>
        </DialogHeader>
        <div className="asset-editor-body">
          <div className="editor-visual">
            <div
              className="editor-image-well"
              style={{
                aspectRatio:
                  compare || edits.ratio === "Original"
                    ? undefined
                    : edits.ratio.replace(":", "/"),
                height:
                  !compare && edits.ratio !== "Original"
                    ? "min(55vh, 500px)"
                    : undefined,
                width:
                  !compare && edits.ratio !== "Original" ? "auto" : undefined,
              }}
            >
              {a.kind === "image" ? (
                <img
                  src={a.url}
                  alt={a.name}
                  style={{
                    filter: compare ? "none" : filter,
                    transform:
                      edits.flip && !compare ? "scaleX(-1)" : undefined,
                  }}
                />
              ) : a.kind === "video" ? (
                <video src={a.url} controls playsInline />
              ) : a.kind === "audio" ? (
                <audio src={a.url} controls />
              ) : (
                <div className="document-preview">
                  <FileText size={48} />
                  <strong>{a.name}</strong>
                  <a href={a.url} target="_blank" rel="noreferrer">
                    Open reference
                    <ArrowUpRight size={15} />
                  </a>
                </div>
              )}
            </div>
            {a.kind === "image" && (
              <div className="compare-toolbar">
                <button
                  className={compare ? "active" : ""}
                  onClick={() => setCompare((v) => !v)}
                >
                  <Eye size={15} />
                  {compare ? "Showing original" : "Compare original"}
                </button>
                <span>Original preserved · edits create a new take</span>
                <button onClick={() => setEdits(defaultEdits)}>
                  <Undo2 size={14} />
                  Reset
                </button>
              </div>
            )}
            <div className="asset-lineage">
              <GitBranch size={15} />
              <span>
                {a.parentId
                  ? "Derived from " +
                    p.assets.find((x) => x.id === a.parentId)?.name
                  : "Source asset"}
              </span>
              <ChevronRight size={12} />
              <span>v{a.version}</span>
              <ChevronRight size={12} />
              <span>
                {p.sharedAssetIds.includes(a.id)
                  ? "Shared production"
                  : "My space"}
              </span>
            </div>
          </div>
          <div className="editor-controls">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="editor-tabs">
                <TabsTrigger value="Adjust">Adjust</TabsTrigger>
                <TabsTrigger value="Context">Context</TabsTrigger>
              </TabsList>
            </Tabs>
            {tab === "Adjust" ? (
              <>
                <label className="field-label" htmlFor="asset-name">
                  Asset name
                </label>
                <input
                  id="asset-name"
                  value={a.name}
                  onChange={(e) => onUpdate({ name: e.target.value })}
                />
                {a.kind === "image" && (
                  <>
                    <label className="field-label">Crop ratio</label>
                    <Choice
                      label="Image crop ratio"
                      value={edits.ratio}
                      onChange={(v) =>
                        setEdits((old) => ({ ...old, ratio: v }))
                      }
                      options={["Original", "16:9", "9:16", "1:1", "4:5"]}
                    />
                    {(["exposure", "contrast", "saturation"] as const).map(
                      (key) => (
                        <div className="adjustment" key={key}>
                          <label>
                            {key === "exposure"
                              ? "Brightness"
                              : key.charAt(0).toUpperCase() + key.slice(1)}
                            <span>{edits[key]}%</span>
                          </label>
                          <Slider
                            aria-label={key}
                            value={[edits[key]]}
                            min={0}
                            max={200}
                            step={1}
                            onValueChange={(v) =>
                              setEdits((old) => ({ ...old, [key]: v[0] }))
                            }
                          />
                        </div>
                      ),
                    )}
                    <label className="check-row">
                      <Checkbox
                        checked={edits.flip}
                        onCheckedChange={(v) =>
                          setEdits((old) => ({ ...old, flip: !!v }))
                        }
                      />
                      Flip horizontally
                    </label>
                    <Button
                      className="btn primary full-width"
                      disabled={saving}
                      onClick={() => void saveTake()}
                    >
                      {saving ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <GitBranch size={15} />
                      )}
                      Save as new take
                    </Button>
                    <button
                      className="download-edit"
                      onClick={async () => {
                        try {
                          downloadFile(
                            await renderImage(a.url, edits),
                            safeName(a.name) + ".png",
                          );
                        } catch {
                          toast.error("Could not download the edit");
                        }
                      }}
                    >
                      <Download size={13} />
                      Download PNG
                    </button>
                  </>
                )}
                {originalAssetDownload(a) && <a className="download-edit" href={originalAssetDownload(a)!.url} download={originalAssetDownload(a)!.filename}><Download size={13}/>Download original · full resolution</a>}
                <div className="asset-state-controls">
                  <span className="field-label">Your select</span>
                  <Choice
                    label="Asset selection status"
                    value={a.status}
                    onChange={(v) => onUpdate({ status: v as Asset["status"] })}
                    options={["Draft", "Selected", "Continuity note"]}
                  />
                  <Button
                    variant="outline"
                    className="btn full-width"
                    onClick={onShare}
                  >
                    <Share2 size={14} />
                    Publish this version
                  </Button>
                  {["image", "video"].includes(a.kind) && (
                    <Button
                      variant="outline"
                      className="btn full-width"
                      onClick={onSequence}
                    >
                      <Film size={14} />
                      Add to sequence
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="asset-prompt">
                  Creative prompt / direction
                </label>
                <textarea
                  id="asset-prompt"
                  className="prompt-editor"
                  value={a.prompt}
                  onChange={(e) => onUpdate({ prompt: e.target.value })}
                />
                <p className="small-copy muted">
                  Direction is saved as metadata. Changing it does not re-render
                  the image.
                </p>
                <label className="check-row">
                  <Checkbox
                    checked={a.locked}
                    onCheckedChange={(v) => onUpdate({ locked: !!v })}
                  />
                  Pin this reference version
                </label>
                <span className="field-label">Reference bindings</span>
                {p.assets
                  .filter((x) => x.id !== a.id)
                  .map((x) => (
                    <label className="binding-choice" key={x.id}>
                      <Checkbox
                        checked={a.refs.includes(x.id)}
                        onCheckedChange={(v) =>
                          onUpdate({
                            refs: v
                              ? [...a.refs, x.id]
                              : a.refs.filter((id) => id !== x.id),
                          })
                        }
                      />
                      <span>
                        {x.name}
                        <small>
                          v{x.version} · {x.category}
                        </small>
                      </span>
                    </label>
                  ))}
                <div className="prompt-advice">
                  <Info size={14} />
                  <p>
                    References guide the next generation. Generative edits,
                    inpainting and upscaling use the production platform’s
                    connected engines.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
