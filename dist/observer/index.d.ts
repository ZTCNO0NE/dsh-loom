import type { Context } from '@deepseek-ai/cordis';
import type { EvolutionSignal, SignalThresholds, TriggerRecord } from '../types.js';
export interface TelemetrySummary {
    schemaVersion: number;
    model?: string;
    turns: number;
    avgTurnMs: number | null;
    maxTurnMs: number | null;
    toolCalls: number;
    toolErrors: number;
    toolErrorRate: number | null;
    perTool: Array<{
        name: string;
        calls: number;
        errors: number;
        avgMs: number | null;
    }>;
    at: string;
}
/** Normalized input event for the observer. dsh wiring maps native events here. */
export type MetaEvent = {
    kind: 'tool-error';
    turn: number;
    step: number;
    tool: string;
    code?: string;
    evidence: string;
} | {
    kind: 'agent-error';
    turn: number;
    step: number;
    error: string;
} | {
    kind: 'user-message';
    turn: number;
    text: string;
} | {
    kind: 'turn-end';
    turn: number;
    reason: string;
} | {
    kind: 'regression-fail';
    caseId: string;
    detail: string;
} | {
    kind: 'reusable-tactic';
    tactic: string;
};
export interface ObserverOptions {
    root: string;
    sessionId: string;
    /** Auto-ingest dsh user/message frames so the invoker can wake the builder. */
    autoIngestUserMessages?: boolean;
}
export interface HardTrigger {
    kind: TriggerRecord['kind'];
    rule: string;
    evidenceRefs: string[];
}
export declare function mapAgentErrorEvent(payload: unknown): MetaEvent | null;
export declare function mapToolResultEvent(exec: unknown, result: unknown): MetaEvent | null;
export declare class Observer {
    private ctx;
    private options;
    private events;
    private turnStarts;
    private toolStarts;
    private turns;
    private tools;
    private lastFrameAt;
    private currentTurnStartAt;
    private currentStep;
    private lastText;
    private repeatedText;
    constructor(ctx: Context | null, options: ObserverOptions);
    /** Normalized entry point; dsh wiring and synthetic tests both use this. */
    ingest(event: MetaEvent): void;
    /** Best-effort dsh event wiring: agent/error (emit) and tools/result (emit). */
    subscribe(): void;
    /** Raw frame recorder for telemetry (turn/tool latency + errors). */
    recordFrame(type: string, data: Record<string, unknown>, time: number, sessionId?: string): void;
    /** Rebuild in-memory telemetry from a persisted frame without appending it. */
    replayFrame(type: string, data: Record<string, unknown>, time: number, sessionId?: string): void;
    private processFrame;
    /** Aggregated actor telemetry (08 §12 I13 extension): latency, errors, calls. */
    collectTelemetry(model?: string): TelemetrySummary;
    lastFrameTime(): number | null;
    currentTurnStart(): number | null;
    currentStepCount(): number;
    repeatedTextCount(): number;
    static mapAgentError(payload: unknown): MetaEvent | null;
    static mapToolResult(exec: unknown, result: unknown): MetaEvent | null;
    /** Threshold filtering; repeated failures are grouped per signature. */
    collect(thresholds: SignalThresholds): EvolutionSignal[];
    /**
     * M3 host hard trigger (L2): deterministic rules evaluated at turn boundaries.
     * No model judgment is involved; the actor cannot suppress these.
     */
    evaluateHardTriggers(thresholds: SignalThresholds): HardTrigger[];
    persistRequirements(text: string, goalRefs?: string[], feedbackRefs?: string[]): void;
    persistTrigger(kind: TriggerRecord['kind'], rule?: string, evidenceRefs?: string[]): void;
    persistSignals(): void;
    reset(): void;
}
