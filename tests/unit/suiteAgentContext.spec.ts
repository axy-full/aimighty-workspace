import { expect, test } from '@playwright/test';
import { atomikContext, atomikRequestSchema } from '../../lib/workbench/atomik-server';
import { seedProject } from '../../lib/workbench/studio';
import { EMPTY_MOLECULR } from '../../lib/workbench/moleculr';

test('campaign planning receives bounded current brand/product/creative context and only selected image IDs', () => {
  const project = seedProject();
  project.assets.push({ ...project.assets[0], id: 'video-ref', kind: 'video' });
  project.moleculr = { ...EMPTY_MOLECULR, productName: 'Actual product', activeProductId: 'active-product', productDescription: 'd'.repeat(4000), productBrand: 'Actual brand',
    productUrl: 'https://example.test/product', productSource: { url: 'https://example.test/product', title: 'Reviewed product page', reviewedAt: '2026-09-17T00:00:00.000Z' },
    productAssetIds: ['environment', 'missing', 'video-ref'], castAssetIds: ['character', 'hero'],
    brandKit: { name: 'Actual brand', tagline: 'A considered line', voice: 'v'.repeat(2000), audience: 'a'.repeat(2000), colors: ['#112233'], font: 'editorial', logoAssetId: 'hero' },
    creative: { path: 'template', category: 'ugc', templateId: 'ugc-presenter', direction: 'c'.repeat(6000), aspect: '9:16', seconds: 15 },
  };
  const input = atomikRequestSchema.parse({ projectId: project.id, requestId: 'context-request', request: 'Develop this campaign.', suite: 'moleculr', refs: ['environment', 'character', 'video-ref'] });
  const context = JSON.parse(atomikContext(project, input));
  const campaign = context.project.campaign;
  expect(campaign).toMatchObject({ productName: 'Actual product', productBrand: 'Actual brand', activeProductId: 'active-product', productSource: { title: 'Reviewed product page' },
    creative: { templateId: 'ugc-presenter', aspect: '9:16', seconds: 15 }, brandKit: { colors: ['#112233'], font: 'editorial' }, productAssetIds: ['environment'], castAssetIds: ['character'] });
  expect(campaign.productDescription).toHaveLength(3000);
  expect(campaign.brandKit.voice).toHaveLength(1000);
  expect(campaign.brandKit.audience).toHaveLength(1000);
  expect(campaign.creative.direction).toHaveLength(3000);
  expect(campaign.brandKit.logoAssetId).toBeUndefined();
  expect(campaign.productEvidence).toContain('has not fetched');
  expect(context.selectedReferences.every((reference: { evidence: string }) => reference.evidence.includes('has not been viewed'))).toBe(true);
  expect(JSON.parse(atomikContext(project, { ...input, refs: [...input.refs, 'hero'] })).project.campaign.brandKit.logoAssetId).toBe('hero');
});

test('legacy marketing plans receive the saved campaign facts, while old projects remain valid', () => {
  const project = seedProject();
  const input = atomikRequestSchema.parse({ projectId: project.id, requestId: 'context-request', request: 'Write a campaign.', role: 'marketing', refs: [] });
  expect(JSON.parse(atomikContext(project, input)).project.campaign).toBeUndefined();
  project.moleculr = { ...EMPTY_MOLECULR, productDescription: 'A supplied, reviewable description.' };
  expect(JSON.parse(atomikContext(project, input)).project.campaign.productDescription).toBe('A supplied, reviewable description.');
});
