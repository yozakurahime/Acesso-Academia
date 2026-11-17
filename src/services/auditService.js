export class AuditService {
  constructor(store) {
    this.store = store;
  }

  log({ actorUser = null, actorRole = null, action, entity = null, entityId = null, details = null } = {}) {
    const cleanAction = String(action || '').trim();
    if (!cleanAction) {
      throw new Error('Ação de auditoria obrigatória.');
    }
    const serializedDetails =
      details === null || details === undefined
        ? null
        : typeof details === 'string'
          ? details
          : JSON.stringify(details);

    const res = this.store.run(
      `INSERT INTO audit_logs (actor_user, actor_role, action, entity, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        actorUser ? String(actorUser).trim() : null,
        actorRole ? String(actorRole).trim() : null,
        cleanAction,
        entity ? String(entity).trim() : null,
        entityId !== null && entityId !== undefined ? String(entityId) : null,
        serializedDetails,
      ],
    );
    return this.store.get('SELECT * FROM audit_logs WHERE id = ?', [res.lastInsertRowid]);
  }

  list({ limit = 100, entity = null, actorUser = null } = {}) {
    const conditions = [];
    const params = [];

    if (entity) {
      conditions.push('entity = ?');
      params.push(String(entity).trim());
    }
    if (actorUser) {
      conditions.push('LOWER(TRIM(COALESCE(actor_user, \'\'))) = LOWER(?)');
      params.push(String(actorUser).trim());
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    params.push(safeLimit);

    return this.store.all(
      `SELECT id, actor_user, actor_role, action, entity, entity_id, details, created_at
       FROM audit_logs
       ${where}
       ORDER BY id DESC
       LIMIT ?`,
      params,
    );
  }
}
