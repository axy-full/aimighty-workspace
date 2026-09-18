import { billCredits } from '../creditTerms';
import { paidByPlatformEngine } from '../platformSpend';
import type { AstraRuntimeUsage } from './sandbox';
export const ASTRA_COMPUTE_MODEL = 'blender-5.2.2-cpu';
export type AstraComputeRates = {
    cpuUsdPerHour: number;
    memoryUsdPerGbHour: number;
    egressUsdPerGb: number;
    createUsd: number;
};
/** Operator pins the deployment's regional contract; do not guess a financial quote. */
export function astraComputeRates(): AstraComputeRates | null {
    try {
        const value = JSON.parse(process.env.ASTRA_BLENDER_RATE_CARD ?? 'null');
        if (!value || Object.keys(value).sort().join(',') !== 'cpuUsdPerHour,createUsd,egressUsdPerGb,memoryUsdPerGbHour')
            return null;
        for (const n of Object.values(value))
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100)
                return null;
        return value as AstraComputeRates;
    }
    catch {
        return null;
    }
}
export function astraComputeCost(usage: AstraRuntimeUsage, rates: AstraComputeRates) { return Math.max(0, usage.activeCpuMs / 3600000 * rates.cpuUsdPerHour + Math.max(60000, usage.durationMs) / 3600000 * 4 * rates.memoryUsdPerGbHour + usage.egressBytes / 1e9 * rates.egressUsdPerGb + rates.createUsd); }
export const ASTRA_MAX_USAGE: AstraRuntimeUsage = { activeCpuMs: 360000, durationMs: 180000, egressBytes: 512 * 1024 * 1024 };
export function astraComputeCredits(cost: number) { return paidByPlatformEngine('vercel-sandbox') ? billCredits(cost, ASTRA_COMPUTE_MODEL) : 0; }
