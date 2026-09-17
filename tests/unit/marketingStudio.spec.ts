import { test, expect } from '@playwright/test';
import { MARKETING_TASKS, marketingRequest, marketingMarkdown, marketingCsv, isMarketingPlan } from '../../lib/workbench/marketing-studio';
import { atomikRequestSchema } from '../../lib/workbench/atomik-server';
import { newProject, type Asset, type Plan } from '../../lib/workbench/studio';

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: 'marketing-run', request: 'Draft a launch campaign', model: 'approved-model', depth: 'Considered', effort: 'high',
  intent: 'campaign', summary: 'A focused launch for independent editors.', steps: ['Hook A: Your next cut starts here.', 'CTA: Explore the trial.'],
  applied: false, refs: [], role: 'marketing', ...overrides,
});
const asset = (id: string, name: string): Asset => ({
  id, name, kind: 'image', category: 'Reference', url: '/api/uploads/private-source', description: 'Private source description',
  prompt: 'Private source prompt', status: 'Draft', locked: false, version: 1, refs: [],
});

// Parse quoted fields as a recipient would, including embedded row separators.
function readCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r' || char === '\n')) {
      row.push(field); field = '';
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && value[i + 1] === '\n') i++;
      }
    } else field += char;
  }
  expect(quoted).toBe(false);
  row.push(field); rows.push(row);
  return rows;
}

test('each marketing task creates a distinct bounded request while preserving supplied creative direction', () => {
  const direction = 'Write in Hindi.\nKeep the supplied offer exactly as stated.';
  const requests = MARKETING_TASKS.map(task => marketingRequest(task.id, `  ${direction}  `));
  expect(new Set(requests).size).toBe(MARKETING_TASKS.length);
  for (const request of requests) {
    expect(request.endsWith(direction)).toBe(true);
    expect(atomikRequestSchema.parse({ projectId: 'campaign', requestId: 'campaign-request', role: 'marketing', request }).request).toBe(request);
  }
  expect(marketingRequest('copy', direction)).toContain('finished campaign copy');
  expect(marketingRequest('launch', direction)).toContain('relative timing');
  expect(marketingRequest('channels', direction)).toContain('Do not claim to have checked current platform specifications');
});

test('blank direction is omitted and excessive direction cannot overflow the paid request contract', () => {
  expect(marketingRequest('kit', ' \n\t ')).toBe(marketingRequest('kit', ''));
  const request = marketingRequest('copy', `Beginning of user direction ${'x'.repeat(100_000)} END-OUTSIDE-LIMIT`);
  expect(request).toContain('Beginning of user direction');
  expect(request).not.toContain('END-OUTSIDE-LIMIT');
  expect(atomikRequestSchema.safeParse({ projectId: 'campaign', requestId: 'campaign-request', role: 'marketing', request }).success).toBe(true);
});

test('Markdown handoff retains the complete proposal and selected names without exporting private source data', () => {
  const project = newProject('Autumn launch');
  project.assets = [asset('selected', 'Approved hero still'), asset('unused', 'Unused internal reference')];
  const result = plan({ refs: ['selected', 'removed'], summary: 'Summary with a second line.\nKeep this line.', steps: ['First section\nSecond line', 'Final section'] });
  const before = JSON.stringify({ project, result });
  const markdown = marketingMarkdown(project, result);
  for (const text of [project.name, result.id, result.model, result.depth, result.effort!, result.request, result.summary, ...result.steps, 'Approved hero still', 'removed (no longer in project)']) expect(markdown).toContain(text);
  expect(markdown.indexOf(result.steps[0])).toBeLessThan(markdown.indexOf(result.steps[1]));
  for (const value of ['Unused internal reference', '/api/uploads/private-source', 'Private source description', 'Private source prompt']) expect(markdown).not.toContain(value);
  expect(JSON.stringify({ project, result })).toBe(before);
  expect(marketingMarkdown(project, plan({ effort: undefined }))).not.toContain('Reasoning effort:');
  expect(marketingMarkdown(project, plan())).toContain('No assets selected.');
});

test('Markdown resolves valid shared references with the same private-first identity precedence as Atomik', () => {
  const project = newProject('Shared campaign');
  project.assets = [asset('same-id', 'Current private reference')];
  project.sharedAssets = [asset('same-id', 'Shared duplicate reference'), asset('shared-only', 'Shared approved still')];
  const markdown = marketingMarkdown(project, plan({ refs: ['same-id', 'shared-only'] }));
  expect(markdown).toContain('Current private reference');
  expect(markdown).toContain('Shared approved still');
  expect(markdown).not.toContain('Shared duplicate reference');
  expect(markdown).not.toContain('(no longer in project)');
});

test('CSV preserves multiline copy and quote/comma characters as one content field per section', () => {
  const project = newProject('Launch, "Autumn"');
  const result = plan({ summary: 'Headline, "fresh"\r\nBody copy\nCall to action', steps: ['One,"two"\r\nthree', 'नमस्ते — Explore the trial 🚀'] });
  const before = JSON.stringify({ project, result });
  const rows = readCsv(marketingCsv(project, result));
  expect(rows[0]).toEqual(['project', 'run', 'section', 'content']);
  expect(rows.slice(1)).toEqual([
    [project.name, result.id, 'Summary', result.summary],
    [project.name, result.id, '1', result.steps[0]],
    [project.name, result.id, '2', result.steps[1]],
  ]);
  expect(JSON.stringify({ project, result })).toBe(before);
});

test('CSV prevents spreadsheet formulas in every exported text column without losing their contents', () => {
  for (const unsafe of ['=SUM(A1:A2)', '+1+2', '-1+2', '@SUM(A1)', '  =HYPERLINK("https://example.invalid","open")', '\tanything', '\ranything', '\n=1+1']) {
    const project = newProject(unsafe);
    const rows = readCsv(marketingCsv(project, plan({ id: unsafe, summary: unsafe, steps: [unsafe] })));
    for (const row of rows.slice(1)) {
      expect(row).toHaveLength(4);
      for (const index of [0, 1, 3]) expect(row[index], unsafe).toBe("'" + unsafe);
    }
  }
});

test('campaign intent alone does not misclassify existing Genie or production-department plans', () => {
  expect(isMarketingPlan(plan())).toBe(true);
  expect(isMarketingPlan(plan({ role: 'Marketing Studio' }))).toBe(true);
  for (const role of [undefined, 'Director', 'Producer']) expect(isMarketingPlan(plan({ role }))).toBe(false);
});
