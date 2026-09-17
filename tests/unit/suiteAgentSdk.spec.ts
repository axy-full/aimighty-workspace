import { test, expect } from '@playwright/test';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError, type LanguageModelV4GenerateResult, type LanguageModelV4Content } from '@ai-sdk/provider';
import { createSuiteAgent, suiteAgentBounds, suiteAgentInputTokens, suiteAgentMessages, suiteAgentToolBudget, type SuiteAgentEnvelope } from '../../lib/workbench/suite-agent';
import type { SuiteAgentResult } from '../../lib/workbench/suite-agent-plan';

const proposal: SuiteAgentResult = {
  intent: 'shots', summary: 'A reviewable product shot.', steps: ['Review the product proportions.'],
  actions: [{ kind: 'image', title: 'Hero', prompt: 'Soft light on the supplied product; preserve its proportions.', referenceIds: ['product-image'] }],
  hooks: [], assumptions: [],
};
function envelope(patch: Partial<SuiteAgentEnvelope> = {}): SuiteAgentEnvelope {
  const bounds = suiteAgentBounds(10000, 900);
  return { suite: 'moleculr', model: 'mock/no-network', context: 'PROJECT_SENTINEL: a saved product brief.', maxTokens: 900,
    inputTokenBudget: bounds.perStepInputTokens, toolResultByteBudget: bounds.toolResultBytes,
    assetIds: [{ id: 'product-image', kind: 'image' }], images: [], providerOptions: {}, ...patch };
}
function response(content: LanguageModelV4Content[], toolCalls = false): LanguageModelV4GenerateResult {
  return { content, finishReason: { unified: toolCalls ? 'tool-calls' : 'stop', raw: undefined },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 50, text: 50, reasoning: undefined } }, warnings: [] };
}
const inspect = (id: string): LanguageModelV4Content => ({ type: 'tool-call', toolCallId: id, toolName: 'inspect_project', input: '{}' });
const final = () => response([{ type: 'text', text: JSON.stringify(proposal) }]);

test('the genuine SDK loop returns full project data once, checks a proposal, then removes all final-step tools', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [
    response([inspect('inspect-1'), inspect('inspect-duplicate')], true),
    response([{ type: 'tool-call', toolCallId: 'check-1', toolName: 'check_plan', input: JSON.stringify(proposal) }], true),
    final(),
  ] });
  const input = envelope(), checkpoints: unknown[] = [];
  const result = await createSuiteAgent(input, model, async step => { checkpoints.push(step); }).generate({ messages: suiteAgentMessages(input) });
  expect(result.output).toEqual(proposal);
  expect(model.doGenerateCalls).toHaveLength(3);
  expect(model.doGenerateCalls.map(call => call.maxOutputTokens)).toEqual([900, 900, 900]);
  const secondPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
  expect(secondPrompt.match(/PROJECT_SENTINEL/g)).toHaveLength(2); // one user context + one tool result
  expect(secondPrompt).toContain('alreadyInspected');
  expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain('valid');
  expect(model.doGenerateCalls[2].toolChoice).toEqual({ type: 'none' });
  expect(model.doGenerateCalls[2].tools ?? []).toEqual([]);
  expect(checkpoints).toHaveLength(3);
});

test('excess tool calls within one model response stop before purchasing the next SDK step', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [response(Array.from({ length: 20 }, (_, i) => inspect(`duplicate-${i}`)), true), final()] });
  const input = envelope();
  await expect(createSuiteAgent(input, model).generate({ messages: suiteAgentMessages(input) })).rejects.toThrow(/reviewed context or tool limit/);
  expect(model.doGenerateCalls).toHaveLength(1);
});

test('a provider that ignores the final tool restriction cannot buy a fourth model call', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [
    response([inspect('first')], true),
    response([inspect('second')], true),
    response([inspect('ignored-final-restriction')], true),
    final(),
  ] });
  const input = envelope();
  const result = await createSuiteAgent(input, model).generate({ messages: suiteAgentMessages(input) });
  expect(() => result.output).toThrow();
  expect(model.doGenerateCalls).toHaveLength(3);
  expect(model.doGenerateCalls[2].tools ?? []).toEqual([]);
});

test('actual expanded message bytes are checked before the next model step, even if a provider ignores its output bound', async () => {
  const input = envelope();
  const model = new MockLanguageModelV4({ doGenerate: [response([{ type: 'text', text: 'x'.repeat(input.inputTokenBudget) }, inspect('inspect')], true), final()] });
  await expect(createSuiteAgent(input, model).generate({ messages: suiteAgentMessages(input) })).rejects.toThrow(/reviewed context or tool limit/);
  expect(model.doGenerateCalls).toHaveLength(1);
});

test('an undersized initial quote is rejected before any model call, including visual-token overhead', async () => {
  const input = envelope({ images: [{ dataUrl: 'data:image/png;base64,cGl4ZWxz', label: 'Approved bounded review image' }] });
  const messages = suiteAgentMessages(input), required = suiteAgentInputTokens(input, messages);
  const model = new MockLanguageModelV4({ doGenerate: final() });
  await expect(createSuiteAgent({ ...input, inputTokenBudget: required - 1 }, model).generate({ messages })).rejects.toThrow(/reviewed context or tool limit/);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(() => suiteAgentInputTokens(input, [{ role: 'user', content: [{ type: 'image', image: 'https://untrusted.invalid/private-image' }] }])).toThrow();
});

test('tool output has its own total byte cap and repeated checks cannot echo unbounded reference problems', () => {
  const input = envelope({ toolResultByteBudget: 40 });
  const budget = suiteAgentToolBudget(input);
  expect(() => budget.inspect()).toThrow(/reviewed context or tool limit/);
  expect(budget.snapshot()).toMatchObject({ bytes: 0, blocked: true });
  const checks = suiteAgentToolBudget(envelope());
  const invalid = { ...proposal, actions: Array.from({ length: 8 }, () => ({ ...proposal.actions[0], referenceIds: Array.from({ length: 6 }, (_, i) => `unavailable-${i}`) })) };
  expect(checks.check(invalid)).toMatchObject({ valid: false });
  expect(checks.check(invalid)).toMatchObject({ problems: expect.any(Array) });
  expect(checks.check(invalid)).toEqual({ checkLimitReached: true });
  expect(checks.snapshot().bytes).toBeLessThan(4000);
});

test('retryable provider failures never cause the SDK to submit again', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new APICallError({ message: 'Fixture transport failure', url: 'https://mock.invalid', requestBodyValues: {}, statusCode: 503, isRetryable: true }); } });
  const input = envelope();
  await expect(createSuiteAgent(input, model).generate({ messages: suiteAgentMessages(input) })).rejects.toThrow('Fixture transport failure');
  expect(model.doGenerateCalls).toHaveLength(1);
});
