import { uid, type CanvasNode, type Project } from './studio';
import type { DevelopmentJob } from './development-types';
import { parseScreenplay } from './screenplay';
import { PROJECT_LIMITS, limitText } from './project-limits';

/** The canvas's far edge (studio-schema bounds node x and y at 20,000). */
const CANVAS_EDGE = 20000, SCENE_COLUMN = 350, SCENE_ROW = 290;
/**
 * Where `count` scene nodes go below `top`: four columns, widened when the
 * batch would otherwise run off the canvas's bottom edge (a feature-sized
 * canvas). Null when the batch cannot fit inside the canvas at all.
 */
function sceneGrid(count: number, top: number): ((index: number) => { x: number; y: number }) | null {
  const rows = Math.floor((CANVAS_EDGE - top) / SCENE_ROW) + 1;
  if (rows < 1) return null;
  const columns = Math.max(4, Math.ceil(count / rows));
  if (50 + (columns - 1) * SCENE_COLUMN > CANVAS_EDGE) return null;
  return index => ({ x: 50 + (index % columns) * SCENE_COLUMN, y: top + Math.floor(index / columns) * SCENE_ROW });
}

/** The caller verifies the source SHA before entering this synchronous mutation. */
export function applyDevelopment(project: Project, job: DevelopmentJob, choice: { idea: number } | { scenes: string[] }): Project {
  if (job.projectId !== project.id || job.status !== 'succeeded' || !job.result) throw new Error('Choose a completed result for this project.');
  const applied = project.developmentApplications ?? [];
  if ('idea' in choice) {
    const idea = job.result.ideas[choice.idea], key = `${job.id}:idea:${choice.idea}`;
    if (!idea || job.kind !== 'idea') throw new Error('This idea is no longer available.');
    if (applied.includes(key)) throw new Error('This idea is already in the creative direction.');
    const direction = [project.direction, `${idea.title}\n${idea.logline}\n\n${idea.treatment}\n\nVISUAL DIRECTION\n${idea.visualDirection}`].filter(Boolean).join('\n\n');
    if (direction.length > 30000) throw new Error('Make room in Creative direction before adding this idea. Nothing was shortened.');
    if (applied.length >= 1000) throw new Error('The application history is full. Save the result as a separate project.');
    return { ...project, direction, developmentApplications: [...applied, key] };
  }
  if (job.kind === 'idea' || !choice.scenes.length || new Set(choice.scenes).size !== choice.scenes.length) throw new Error('Choose script scenes to add.');
  const scenes = choice.scenes.map(id => {
    const scene = job.result!.scenes.find(value => value.id === id);
    if (!scene) throw new Error('A scene is no longer part of this result.');
    return scene;
  });
  if (project.nodes.length + scenes.length > PROJECT_LIMITS.nodes) throw new Error(`There is room for ${limitText(Math.max(0, PROJECT_LIMITS.nodes - project.nodes.length))} more scene nodes. Add a smaller selection.`);
  const place = sceneGrid(scenes.length, Math.max(1030, ...project.nodes.map(value => value.y + 290)));
  if (!place) throw new Error('Rearrange the canvas before adding more scenes.');
  if (applied.length + scenes.length > 1000) throw new Error('The application history is full. Save the result as a separate project.');
  const sourceScenes = parseScreenplay(project.script ?? '', project.scriptSource?.edited ? undefined : project.scriptSource?.pages);
  const nodes: CanvasNode[] = scenes.map((scene, index) => {
    if (applied.includes(`${job.id}:scene:${scene.id}`)) throw new Error(`${scene.heading} is already on the canvas.`);
    if (scene.sourceStart < 0 || scene.sourceEnd > (project.script?.length ?? 0) || scene.sourceEnd <= scene.sourceStart) throw new Error('This scene has an invalid source range.');
    const text = [scene.heading, `SOURCE\n${project.script!.slice(scene.sourceStart, scene.sourceEnd)}`, `SCENE INTENT\n${scene.summary}`,
      `BEATS\n${scene.beats.map((beat, i) => `${i + 1}. ${beat}`).join('\n')}`,
      `PROPOSED SHOT COVERAGE\n${scene.shots.map((shot, i) => `${i + 1}. ${shot.description}\nFraming: ${shot.framing}\nMovement: ${shot.movement}\nLighting: ${shot.lighting}\nSound: ${shot.sound}`).join('\n\n')}`,
      `PRODUCTION\nCharacters: ${scene.characters.join(', ')}\nProps: ${scene.props.join(', ')}\nLocations: ${scene.locations.join(', ')}\n${scene.productionNotes.join('\n')}`].join('\n\n');
    if (text.length > 30000 || scene.heading.length > 300) throw new Error('This scene exceeds the canvas text limit. Its complete analysis remains in Script; nothing was shortened.');
    const source = sourceScenes.find(value => value.start === scene.sourceStart && value.end === scene.sourceEnd);
    const node: CanvasNode = { id: uid('node'), title: scene.heading, type: 'scene', text, ...place(index), width: 300, linked: [],
      developmentSource: { jobId: job.id, sourceHash: job.sourceHash, sceneId: scene.id, ...(project.scriptSource ? { sourceAssetId: project.scriptSource.assetId } : {}), sourceStart: scene.sourceStart, sourceEnd: scene.sourceEnd },
      ...(source ? { scriptScene: { id: source.id, sourceKey: source.sourceKey, sourceAssetId: project.scriptSource?.assetId, pageStart: source.pageStart, pageEnd: source.pageEnd } } : {}) };
    return node;
  });
  return { ...project, nodes: [...project.nodes, ...nodes], developmentApplications: [...applied, ...scenes.map(scene => `${job.id}:scene:${scene.id}`)] };
}
