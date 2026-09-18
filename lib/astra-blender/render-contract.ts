/** Client-safe native rendering transport. Source code is always read from the saved project. */
export type AstraRenderSource = 'scene' | 'native';
export type AstraRenderStatus = 'queued' | 'starting' | 'running' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export type AstraRenderArtifact = {
    kind: 'blend' | 'preview' | 'glb';
    assetId: string;
    uploadId: string;
    url: string;
    filename: string;
    mime: string;
    bytes: number;
};
export type AstraRenderJob = {
    id: string;
    requestId: string;
    projectId: string;
    source: AstraRenderSource;
    sourceDigest: string;
    status: AstraRenderStatus;
    estimateCredits: number;
    billedCredits: number | null;
    costUsd: number | null;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    artifacts: AstraRenderArtifact[];
    assetsRegistered: boolean;
};
export type AstraRenderQuote = {
    estimateCredits: number;
    maxCostUsd: number;
    quoteDigest: string;
    sourceDigest: string;
    expiresAt: number;
    billingNote: string;
};
export type AstraRenderRequest = {
    projectId: string;
    requestId: string;
    source: AstraRenderSource;
    sourceDigest: string;
    quoteOnly?: boolean;
    quoteDigest?: string;
    maxCredits?: number;
};
export type AstraRenderRuntime = {
    configured: boolean;
    reason: string | null;
    blenderVersion: string;
    timeoutMs: number;
    vcpus: number;
    memoryMb: number;
};
export const ASTRA_RENDER_TERMINAL: AstraRenderStatus[] = ['succeeded', 'failed', 'cancelled'];
