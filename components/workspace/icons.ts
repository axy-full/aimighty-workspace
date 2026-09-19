import {
  AudioLines, AudioWaveform, BadgeCheck, BookOpen, Bot, Box, Boxes, Clapperboard, CirclePlus, Columns2,
  Cpu, Diamond, Film, FileText, GitBranch, GitFork, Hammer, History, Image, Images, Layers, LayoutGrid,
  ListChecks, Megaphone, Smartphone, MessageSquare, Mountain, Move, Music, Package, Palette, PersonStanding, Puzzle,
  Replace, Rows2, ScanFace, Scissors, Send, Share, Shirt, SlidersHorizontal, Sparkles, Split, Square,
  Upload, User, Users, Wallet, Wand, Wind, type LucideIcon,
} from "lucide-react";
import type { PageId } from "@/lib/workspace/types";

/** Home feature cards: one glyph per page. */
export const PAGE_ICONS: Record<PageId, LucideIcon> = {
  brief: FileText, boards: Images, cast: ScanFace, astra: Boxes, rig: Clapperboard, takes: LayoutGrid,
  edit: Film, deliver: Send,
  agent: Bot, runs: ListChecks, generate: Sparkles, recipes: BookOpen, builds: Hammer, skills: Puzzle,
  models: Cpu, approvals: BadgeCheck, budget: Wallet,
  marketing: Megaphone,
  motion: PersonStanding, swap: Replace, shorts: Smartphone, sources: Upload, compare: Columns2, history: History,
};

/** Library tools by name; anything unnamed cycles the fallbacks. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  brief: FileText, "look board": Palette, character: User, "world & element": Mountain, media: Image,
  scene: Clapperboard, generate: Sparkles, composite: Layers, colour: Palette, transform: Move,
  sound: AudioLines, switch: GitFork, version: GitBranch, versions: GitBranch, approve: BadgeCheck,
  export: Share, identity: ScanFace, wardrobe: Shirt, casting: Users, object: Box, environment: Mountain,
  prop: Package, "all assets": LayoutGrid, uploads: Upload, generations: Wand, compare: Split,
  "send to edit": Scissors, assembly: Film, "colour match": Palette, dialogue: MessageSquare,
  "sound effects": AudioWaveform, ambience: Wind, "music score": Music, mix: SlidersHorizontal,
};
const FALLBACK: LucideIcon[] = [Square, CirclePlus, Diamond, Rows2];

export function toolIcon(name: string, index: number): LucideIcon {
  return TOOL_ICONS[name.toLowerCase()] ?? FALLBACK[index % FALLBACK.length];
}
