import { AuditLog } from './models.js';

export function recordAudit(req, payload) {
  AuditLog.create({
    actorId: req.user?._id,
    action: payload.action,
    entityType: payload.entityType,
    entityId: payload.entityId,
    summary: payload.summary,
    before: payload.before,
    after: payload.after,
    ip: req.ip,
  }).catch((error) => console.error('Audit log failed', error.message));
}
