import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, readJson } from '../protocol/index.js';
/**
 * A deliberately small, durable projection of a conversation's evolution
 * task. Plans/runs remain immutable records; this file only says which one is
 * currently being discussed so a new request cannot silently replace it.
 */
export class EvolutionTaskSessionStore {
    root;
    sessionId;
    constructor(root, sessionId) {
        this.root = root;
        this.sessionId = sessionId;
    }
    read() {
        return readJson(this.file()) ?? {
            schemaVersion: 1, sessionId: this.sessionId, updatedAt: new Date(0).toISOString(),
        };
    }
    beginPending(value) {
        const state = this.read();
        if (state.pending || state.active || (state.diagnosis && state.diagnosis.state !== 'aborted'))
            throw new Error('该会话已有诊断、等待确认或进行中的演进任务；请先查看、取消或完成当前任务');
        state.pending = structuredClone(value);
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    beginDiagnosis(value) {
        const state = this.read();
        if (state.pending || state.active || (state.diagnosis && state.diagnosis.state !== 'aborted'))
            throw new Error('该会话已有诊断、等待确认或进行中的演进任务');
        state.diagnosis = structuredClone(value);
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    setDiagnosisState(runId, next) {
        const state = this.read();
        if (!state.diagnosis || state.diagnosis.runId !== runId)
            throw new Error('当前会话没有对应的方向诊断');
        state.diagnosis.state = next;
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    consumeDiagnosis(runId) {
        const state = this.read();
        if (!state.diagnosis || state.diagnosis.runId !== runId || state.diagnosis.state !== 'waiting_for_choice')
            throw new Error('方向诊断尚未等待用户选择');
        delete state.diagnosis;
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    replaceDiagnosisWithPending(runId, value) {
        const state = this.read();
        if (!state.diagnosis || state.diagnosis.runId !== runId || state.diagnosis.state !== 'waiting_for_choice')
            throw new Error('方向诊断尚未等待用户选择');
        if (state.pending || state.active)
            throw new Error('该会话已有等待确认或进行中的演进任务');
        delete state.diagnosis;
        state.pending = structuredClone(value);
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    beginActive(planId, jobId) {
        const state = this.read();
        if (!state.pending || state.pending.planId !== planId)
            throw new Error('只能确认当前等待确认的任务');
        state.active = { planId, jobId, cursor: 'queued' };
        delete state.pending;
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    setCursor(planId, cursor) {
        const state = this.read();
        if (state.active?.planId === planId)
            state.active.cursor = cursor;
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    finish(planId, stateName) {
        const state = this.read();
        const jobId = state.active?.planId === planId ? state.active.jobId : undefined;
        if (state.pending?.planId === planId)
            delete state.pending;
        if (state.active?.planId === planId)
            delete state.active;
        state.recent = { planId, ...(jobId ? { jobId } : {}), state: stateName };
        state.updatedAt = new Date().toISOString();
        this.write(state);
        return state;
    }
    currentPlanId() { const state = this.read(); return state.pending?.planId ?? state.active?.planId ?? state.recent?.planId; }
    file() { return join(this.root, 'user-evolution', this.sessionId, 'task-session.json'); }
    write(value) { mkdirSync(join(this.root, 'user-evolution', this.sessionId), { recursive: true }); atomicWriteJson(this.file(), value); }
}
