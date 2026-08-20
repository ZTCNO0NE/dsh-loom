import { appendJsonl, atomicWriteJson, paths, PROTOCOL_VERSION } from '../protocol/index.js';
import { DEFAULT_LOCKED_TARGETS, isLockedTarget } from '../policy.js';
export class Gate {
    ctx;
    meta;
    lockedTargets;
    pending = [];
    constructor(ctx, meta = { root: '', sessionId: '' }, lockedTargets = DEFAULT_LOCKED_TARGETS) {
        this.ctx = ctx;
        this.meta = meta;
        this.lockedTargets = lockedTargets;
    }
    pendingCount() {
        return this.pending.length;
    }
    enqueue(patch) {
        this.pending.push(patch);
    }
    async drain(ops) {
        const results = [];
        for (const patch of this.pending.splice(0)) {
            results.push(await this.applyWithRollback(patch, ops));
        }
        return results;
    }
    /**
     * Prime-agent style cold apply: snapshot -> baseline conflict check ->
     * atomic write -> smoke -> rollback on failure. History is append-only.
     */
    async applyWithRollback(patch, ops) {
        if (isLockedTarget(patch, this.lockedTargets)) {
            const result = {
                patch,
                before: {},
                after: patch.config,
                applied: false,
                error: `target ${patch.targetId} is locked (loop layer)`,
            };
            this.record(patch.id, 'locked-target-reject', {}, patch.config, result.error);
            return result;
        }
        if (patch.action === 'insert') {
            return this.applyInsert(patch, ops);
        }
        const before = ops.readConfig(patch.targetId);
        if (ops.baseline && JSON.stringify(ops.baseline) !== JSON.stringify(before)) {
            const result = {
                patch,
                before,
                after: patch.config,
                applied: false,
                conflict: 'entry changed during planning',
            };
            this.record(patch.id, 'reject-conflict', before, patch.config, result.conflict);
            return result;
        }
        let overlay;
        try {
            overlay = (await ops.writeConfig(patch.targetId, patch.config, patch)) ?? undefined;
        }
        catch (error) {
            const result = {
                patch,
                before,
                after: patch.config,
                applied: false,
                error: `write failed: ${String(error)}`,
            };
            this.record(patch.id, 'apply-error', before, patch.config, result.error);
            return result;
        }
        const smoke = await ops.smoke(patch, before);
        if (!smoke.passed) {
            let rollbackError;
            try {
                if (ops.restoreConfig) {
                    await ops.restoreConfig(patch.targetId, before, patch);
                }
                else {
                    await ops.writeConfig(patch.targetId, before, patch);
                }
            }
            catch (error) {
                rollbackError = `rollback failed: ${String(error)}`;
            }
            const result = {
                patch,
                before,
                after: before,
                applied: false,
                smoke,
                error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
            };
            this.record(patch.id, rollbackError ? 'rollback-error' : 'rollback', before, before, result.error, { smoke });
            return result;
        }
        const result = {
            patch,
            before,
            after: patch.config,
            applied: true,
            smoke,
            overlay,
        };
        this.record(patch.id, 'apply', before, patch.config, undefined, { ...(overlay ? { overlay } : {}), smoke });
        return result;
    }
    /** Roll back one already-installed config patch from its Gate-owned before snapshot. */
    async rollbackInstalledConfig(patch, installedBefore, ops) {
        const current = ops.readConfig(patch.targetId);
        const at = new Date().toISOString();
        const finish = (receipt) => {
            if (this.meta.root && this.meta.sessionId) {
                atomicWriteJson(paths.rollbackReceipt(this.meta.root, this.meta.sessionId, patch.id), receipt);
            }
            return receipt;
        };
        if (patch.targetKind !== 'config' || patch.action === 'insert') {
            const error = 'installed config rollback requires an update config patch';
            this.record(patch.id, 'installed-rollback-error', current, current, error);
            return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, error, at });
        }
        if (JSON.stringify(current) !== JSON.stringify(patch.config)) {
            const conflict = 'installed config changed after Gate apply';
            this.record(patch.id, 'installed-rollback-conflict', current, current, conflict);
            return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, conflict, at });
        }
        if (!ops.restoreConfig) {
            const error = 'restoreConfig is unavailable';
            this.record(patch.id, 'installed-rollback-error', current, current, error);
            return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: current, error, at });
        }
        try {
            await ops.restoreConfig(patch.targetId, installedBefore, patch);
            const restored = ops.readConfig(patch.targetId);
            if (JSON.stringify(restored) !== JSON.stringify(installedBefore)) {
                const error = 'rollback readback does not match the Gate before snapshot';
                this.record(patch.id, 'installed-rollback-error', current, restored, error);
                return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: restored, error, at });
            }
            this.record(patch.id, 'installed-rollback', current, restored);
            return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: true, before: current, after: restored, at });
        }
        catch (caught) {
            const error = `rollback failed: ${String(caught)}`;
            this.record(patch.id, 'installed-rollback-error', current, ops.readConfig(patch.targetId), error);
            return finish({ schemaVersion: PROTOCOL_VERSION, patchId: patch.id, targetId: patch.targetId, action: 'rollback-installed-config', rolledBack: false, before: current, after: ops.readConfig(patch.targetId), error, at });
        }
    }
    async applyInsert(patch, ops) {
        const before = {};
        if (patch.targetKind === 'skill') {
            return this.applyInsertSkill(patch, ops, before);
        }
        if (!ops.insertRow || !ops.removeRow) {
            const result = { patch, before, after: patch.config, applied: false, error: 'insert ops not available' };
            this.record(patch.id, 'insert-error', before, patch.config, result.error);
            return result;
        }
        if (ops.rowExists && ops.rowExists(patch.targetId)) {
            const result = { patch, before, after: patch.config, applied: false, conflict: 'row already exists' };
            this.record(patch.id, 'insert-conflict', before, patch.config, result.conflict);
            return result;
        }
        try {
            await ops.insertRow(patch);
        }
        catch (error) {
            const result = { patch, before, after: patch.config, applied: false, error: `insert failed: ${String(error)}` };
            this.record(patch.id, 'insert-error', before, patch.config, result.error);
            return result;
        }
        const smoke = await ops.smoke(patch, before);
        if (!smoke.passed) {
            let rollbackError;
            try {
                await ops.removeRow(patch.targetId);
            }
            catch (error) {
                rollbackError = `insert rollback failed: ${String(error)}`;
            }
            const result = {
                patch,
                before,
                after: {},
                applied: false,
                smoke,
                error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
            };
            this.record(patch.id, rollbackError ? 'insert-rollback-error' : 'insert-rollback', before, {}, result.error, { smoke });
            return result;
        }
        const result = { patch, before, after: patch.config, applied: true, smoke };
        this.record(patch.id, 'insert', before, patch.config, undefined, { smoke });
        return result;
    }
    /** M4: skill patches install SKILL.md files into a skill root (no loader row). */
    async applyInsertSkill(patch, ops, before) {
        if (!ops.installSkill || !ops.removeSkill) {
            const result = { patch, before, after: patch.config, applied: false, error: 'skill ops not available' };
            this.record(patch.id, 'skill-insert-error', before, patch.config, result.error);
            return result;
        }
        if (ops.skillExists && ops.skillExists(patch.targetId)) {
            const result = { patch, before, after: patch.config, applied: false, conflict: 'skill already exists' };
            this.record(patch.id, 'skill-conflict', before, patch.config, result.conflict);
            return result;
        }
        try {
            await ops.installSkill(patch);
        }
        catch (error) {
            const result = { patch, before, after: patch.config, applied: false, error: `skill install failed: ${String(error)}` };
            this.record(patch.id, 'skill-insert-error', before, patch.config, result.error);
            return result;
        }
        const smoke = await ops.smoke(patch, before);
        if (!smoke.passed) {
            let rollbackError;
            try {
                await ops.removeSkill(patch.targetId);
            }
            catch (error) {
                rollbackError = `skill rollback failed: ${String(error)}`;
            }
            const result = {
                patch,
                before,
                after: {},
                applied: false,
                smoke,
                error: rollbackError ?? `smoke failed: ${smoke.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`,
            };
            this.record(patch.id, rollbackError ? 'skill-insert-rollback-error' : 'skill-insert-rollback', before, {}, result.error, { smoke });
            return result;
        }
        const result = { patch, before, after: patch.config, applied: true, smoke };
        this.record(patch.id, 'skill-insert', before, patch.config, undefined, { smoke });
        return result;
    }
    /** Persist the patch state machine (I11). */
    markStatus(root, sessionId, patchId, state, operator, iteration, error) {
        const status = {
            schemaVersion: PROTOCOL_VERSION,
            patchId,
            state,
            updatedAt: new Date().toISOString(),
            operator,
            iteration,
            error,
        };
        atomicWriteJson(paths.status(root, sessionId, patchId), status);
    }
    record(patchId, action, before, after, error, extra) {
        if (!this.meta.root || !this.meta.sessionId)
            return;
        appendJsonl(paths.history(this.meta.root, this.meta.sessionId), {
            schemaVersion: PROTOCOL_VERSION,
            patchId,
            action,
            before,
            after,
            error,
            ...extra,
            at: new Date().toISOString(),
        });
    }
}
