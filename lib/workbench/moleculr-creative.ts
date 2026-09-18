import { z } from 'zod';
import type { MoleculrBrief, MoleculrFormat } from './moleculr';

const id = z.string().min(1).max(100);
export const brandKitSchema = z.object({
  name: z.string().max(200), tagline: z.string().max(300), voice: z.string().max(2000), audience: z.string().max(2000),
  colors: z.array(z.string().regex(/^#[\da-f]{6}$/i)).max(8), font: z.enum(['system', 'editorial', 'geometric']), logoAssetId: id.optional(),
  website: z.string().max(2000).optional(), description: z.string().max(4000).optional(),
  fontFamilies: z.array(z.string().max(120)).max(8).optional(),
  source: z.object({url:z.string().url().max(2048).refine(value=>/^https?:\/\//i.test(value)),reviewedAt:z.string().datetime()}).strict().optional(),
}).strict();
export const productSourceSchema = z.object({ url: z.string().url().max(2000).refine(value => /^https?:\/\//i.test(value)), title: z.string().max(300).optional(), reviewedAt: z.string().datetime() }).strict();
export const productProfileSchema = z.object({
  id, name: z.string().max(200), url: z.string().max(2000), description: z.string().max(4000), brand: z.string().max(200),
  assetIds: z.array(id).max(5), source: productSourceSchema.optional(),
}).strict();
export const CREATIVE_CATEGORIES = [
  { id: 'product-shots', label: 'Product Shots', description: 'Studio, lifestyle and with a model.' },
  { id: 'ads', label: 'Ads', description: 'A clear message for every placement.' },
  { id: 'marketplace', label: 'Marketplace', description: 'Accurate images made for a listing.' },
  { id: 'posters', label: 'Posters', description: 'Compose editable type, images and shapes.' },
  { id: 'ugc', label: 'UGC Videos', description: 'Faceless, talking head and silent stories.' },
  { id: 'motion', label: 'Motion', description: 'Product films, graphics and mixed media.' },
] as const;
export type CreativeCategory = typeof CREATIVE_CATEGORIES[number]['id'];
export const creativeSchema = z.object({
  kind: z.enum(['image', 'video']).optional(),
  path: z.enum(['template', 'prompt']), category: z.enum(['product-shots', 'ads', 'marketplace', 'posters', 'ugc', 'motion']),
  templateId: id.optional(), direction: z.string().max(6000), aspect: z.enum(['1:1', '4:5', '9:16', '16:9']), seconds: z.number().int().min(1).max(60),
}).strict();
export type BrandKit = z.infer<typeof brandKitSchema>;
export type ProductProfile = z.infer<typeof productProfileSchema>;
export type MoleculrCreative = z.infer<typeof creativeSchema>;
export type CreativeTemplate = {
  id: string; category: CreativeCategory; name: string; description: string; format: MoleculrFormat; kind: 'image' | 'video';
  direction: string; aspect: MoleculrCreative['aspect']; beats: { title: string; prompt: string; seconds: number }[];
};
export const EMPTY_BRAND_KIT: BrandKit = { name: '', tagline: '', voice: '', audience: '', colors: ['#141414', '#FFFFFF'], font: 'system' };
export const DEFAULT_CREATIVE: MoleculrCreative = { path: 'template', category: 'product-shots', direction: '', aspect: '1:1', seconds: 15 };

// Original Particl creative briefs, not a copy of Higgsfield's proprietary catalog.
// Every card is executable through the existing reviewed image/video pipeline.
export const CREATIVE_TEMPLATES: CreativeTemplate[] = [
  { id: 'studio-seamless', category: 'product-shots', name: 'Studio essential', description: 'A precise product portrait on a seamless sweep.', format: 'cinematic-demo', kind: 'image', aspect: '1:1', direction: 'A single hero product centered on a neutral seamless studio sweep. Large soft key, controlled edge light, natural contact shadow, accurate materials. 85mm product lens, crisp label and packaging geometry. No invented accessories or text.', beats: [] },
  { id: 'lifestyle-moment', category: 'product-shots', name: 'Everyday ritual', description: 'Put the product in a believable daily moment.', format: 'cinematic-demo', kind: 'image', aspect: '4:5', direction: 'Place the exact product in an authentic lived-in context appropriate to its use. Motivated window light, tactile surfaces, restrained styling, editorial 50mm framing. Product stays visually dominant and recognizably identical.', beats: [] },
  { id: 'editorial-model', category: 'product-shots', name: 'With a model', description: 'An editorial frame with your selected presenter.', format: 'try-on', kind: 'image', aspect: '4:5', direction: 'Use the selected cast reference with the product in a natural, anatomically plausible pose. Editorial medium portrait, soft directional key, clean styling. Match the reference identity, packaging and scale. Do not imply a testimonial.', beats: [] },
  { id: 'hero-ad', category: 'ads', name: 'Hero statement', description: 'One product with generous copy space.', format: 'poster', kind: 'image', aspect: '4:5', direction: 'An arresting product hero on a graphic background informed by the brand palette. Place the product in the lower two thirds and preserve quiet copy space above. Controlled specular highlights and clean silhouette. Create a production plate without typography.', beats: [] },
  { id: 'detail-ad', category: 'ads', name: 'Made in the details', description: 'A material detail that communicates craft.', format: 'cgi', kind: 'image', aspect: '1:1', direction: 'A close-up of an actual visible product detail from the original reference. Macro photographic texture, precise focus, shaped sidelight. Keep materials honest. No fabricated feature labels, certifications or performance promises.', beats: [] },
  { id: 'story-ad', category: 'ads', name: 'Vertical spotlight', description: 'A strong mobile composition with a clear focal point.', format: 'poster', kind: 'image', aspect: '9:16', direction: 'Vertical product campaign composition. Product centered within the middle safe area, open upper area for a headline and lower area for a call to action added in Design. Bold but restrained brand palette, directional studio lighting.', beats: [] },
  { id: 'listing-clean', category: 'marketplace', name: 'Clean listing', description: 'Uncluttered, accurate product presentation.', format: 'marketplace', kind: 'image', aspect: '1:1', direction: 'The complete product on a pure white background, fully inside the frame with an even margin. Preserve exact geometry, color, parts and packaging. No additional items, graphics, badges or text. Platform-specific requirements must be reviewed before publishing.', beats: [] },
  { id: 'listing-context', category: 'marketplace', name: 'In use', description: 'Make the intended use easy to understand.', format: 'marketplace', kind: 'image', aspect: '1:1', direction: 'Show the supplied product in its intended real-world use, clearly visible and realistically scaled. Natural lighting and a simple supportive environment. Do not invent dimensions, included accessories or unsupported functions.', beats: [] },
  { id: 'listing-detail', category: 'marketplace', name: 'Material close-up', description: 'Give buyers a clear look at a real detail.', format: 'marketplace', kind: 'image', aspect: '1:1', direction: 'Photograph an existing product surface or feature from the references at close range. Honest texture, diffused illumination, neutral color balance and sufficient depth of field. Do not add labels or invisible functions.', beats: [] },
  { id: 'type-poster', category: 'posters', name: 'Editorial poster', description: 'A balanced image plate for editable typography.', format: 'poster', kind: 'image', aspect: '4:5', direction: 'Produce an editorial poster background with a lower-right product hero and generous clean negative space at the upper left. Palette follows the brand kit. Rich directional light. No baked-in typography; text and logo remain separate editable layers.', beats: [] },
  { id: 'launch-poster', category: 'posters', name: 'Launch announcement', description: 'A graphic product reveal for a campaign launch.', format: 'poster', kind: 'image', aspect: '1:1', direction: 'A bold product launch plate: one hero product on an architectural plinth, a crisp shape of light and an uncluttered brand-color background. Keep space around the product for separate editable headline and launch details.', beats: [] },
  { id: 'wide-poster', category: 'posters', name: 'Campaign banner', description: 'A wide image with a distinct text area.', format: 'poster', kind: 'image', aspect: '16:9', direction: 'Wide campaign plate with the product on the right third, left half as a clean low-detail copy area. Brand palette and controlled studio lighting. No baked-in text, logos or claims.', beats: [] },
  { id: 'ugc-faceless', category: 'ugc', name: 'Faceless demonstration', description: 'Show the process through hands and product details.', format: 'tutorial', kind: 'video', aspect: '9:16', direction: 'Vertical phone-shot demonstration, natural daylight, believable hand movement and honest product use. Keep the same surface, product and light through every shot. Sound: clean handling and environment, no invented testimonial.', beats: [{ title: 'The setup', prompt: 'Overhead view of the product on a real work surface; hands enter and introduce the object.', seconds: 4 }, { title: 'The demonstration', prompt: 'Show one supported product action clearly in close-up with steady framing and accurate continuity.', seconds: 7 }, { title: 'The result', prompt: 'Resolve on a clean view of the product in use, hold long enough for a separate end card.', seconds: 4 }] },
  { id: 'ugc-presenter', category: 'ugc', name: 'Talking head', description: 'A consistent presenter introduces the product.', format: 'ugc-review', kind: 'video', aspect: '9:16', direction: 'An adult presenter matching the selected cast speaks naturally to a phone camera. Eye-level medium framing, soft daylight, natural pauses. Describe approved product facts only; do not fabricate personal experience or endorsements. Maintain face, voice and wardrobe continuity.', beats: [{ title: 'The opening', prompt: 'Presenter faces the camera holding the product, introduces the campaign hook with a natural delivery.', seconds: 4 }, { title: 'Show the product', prompt: 'Presenter demonstrates the visible product with a close insert. Dialogue uses approved product facts only.', seconds: 7 }, { title: 'The invitation', prompt: 'Return to the same presenter and offer a concise invitation to learn more; hold the product clearly.', seconds: 4 }] },
  { id: 'ugc-silent', category: 'ugc', name: 'Silent unboxing', description: 'Tactile product storytelling without spoken claims.', format: 'unboxing', kind: 'video', aspect: '9:16', direction: 'A silent, tactile unboxing in vertical phone framing. Natural hands, consistent package and no added contents. Native handling sounds and restrained room tone; no dialogue. Preserve the exact packaging from references.', beats: [{ title: 'First impression', prompt: 'Hands place the unopened supplied package on a clean table. Slow considered motion.', seconds: 4 }, { title: 'The reveal', prompt: 'Open the actual packaging and reveal only the supplied product; close views of material texture.', seconds: 7 }, { title: 'Hero hold', prompt: 'Set the product beside its packaging, stop movement and hold a clean final composition.', seconds: 4 }] },
  { id: 'motion-orbit', category: 'motion', name: 'Product orbit', description: 'A controlled cinematic move around the hero.', format: 'cgi', kind: 'video', aspect: '16:9', direction: 'A cinematic product film with slow controlled camera motion, sculpted studio light and physically consistent reflections. Preserve the exact product at every angle; avoid showing unreferenced details. Restrained designed sound.', beats: [{ title: 'Reveal', prompt: 'A motivated light sweep reveals the product silhouette against a brand-colored background.', seconds: 4 }, { title: 'Orbit', prompt: 'Slow quarter orbit around the product with a stable focal length and consistent geometry.', seconds: 7 }, { title: 'Resolve', prompt: 'Camera settles into a clean hero composition; reflections and motion settle naturally.', seconds: 4 }] },
  { id: 'motion-graphic', category: 'motion', name: 'Graphic rhythm', description: 'Brand shapes and product movement with a clear beat.', format: 'motion', kind: 'video', aspect: '9:16', direction: 'Graphic product motion using simple brand-colored shapes, clear depth and restrained rhythmic movement. Clean intentional transitions. Product remains legible and undistorted. Leave text out for post-production; sound follows visible movement.', beats: [{ title: 'Introduce', prompt: 'A simple geometric shape reveals the product in a centered vertical composition.', seconds: 4 }, { title: 'Build rhythm', prompt: 'Product and supporting graphic shapes move on a precise restrained rhythm with consistent scale.', seconds: 7 }, { title: 'End card', prompt: 'Everything resolves into a still hero composition with room for editable logo and CTA.', seconds: 4 }] },
  { id: 'motion-mixed', category: 'motion', name: 'Mixed media', description: 'A tactile collage built around real product imagery.', format: 'motion', kind: 'video', aspect: '4:5', direction: 'A refined mixed-media product collage, tactile paper and printed textures around the exact photographic product. Intentional stop-motion rhythm and coherent brand palette. Do not distort the product or bake in unapproved copy.', beats: [{ title: 'Arrival', prompt: 'A paper collage layer reveals the product reference with a tactile stop-motion transition.', seconds: 4 }, { title: 'Explore', prompt: 'Layered brand-color shapes and real product close-ups form a coherent collage sequence.', seconds: 7 }, { title: 'Signature', prompt: 'Resolve on the product and a calm field for the brand signature added in post.', seconds: 4 }] },
];

export function captureProduct(brief: MoleculrBrief, productId: string): ProductProfile {
  return productProfileSchema.parse({ id: productId, name: brief.productName, url: brief.productUrl, description: brief.productDescription ?? '', brand: brief.productBrand ?? '', assetIds: brief.productAssetIds, ...(brief.productSource ? { source: brief.productSource } : {}) });
}
export function saveProduct(brief: MoleculrBrief, productId: string): MoleculrBrief {
  const profile = captureProduct(brief, productId);
  const products = [...(brief.products ?? [])];
  const index = products.findIndex(item => item.id === productId);
  if (index < 0 && products.length >= 24) throw new Error('This project already has 24 product profiles.');
  if (index < 0) products.push(profile); else products[index] = profile;
  return { ...brief, activeProductId: productId, products };
}
export function switchProduct(brief: MoleculrBrief, productId: string): MoleculrBrief {
  const saved = brief.activeProductId ? saveProduct(brief, brief.activeProductId) : brief;
  const profile = saved.products?.find(item => item.id === productId);
  if (!profile) throw new Error('This product profile is no longer available.');
  return { ...saved, activeProductId: profile.id, productName: profile.name, productUrl: profile.url, productDescription: profile.description, productBrand: profile.brand, productAssetIds: [...profile.assetIds], productSource: profile.source };
}
export function creativeTemplate(brief: MoleculrBrief) {
  return brief.creative?.path === 'template' ? CREATIVE_TEMPLATES.find(item => item.id === brief.creative?.templateId && item.category === brief.creative?.category) : undefined;
}
