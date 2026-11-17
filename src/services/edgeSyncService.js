import { randomUUID } from 'node:crypto';
import { fitnessToday } from './fitnessProgress.js';

const EDGE_SAFE_SETTINGS = [
  'tolerance_days',
  'antipassback_minutes',
  'max_capacity',
  'require_daily_checkin',
  'wellhub_require_checkin',
  'totalpass_require_checkin',
];

export class EdgeCloudHub {
  constructor(store) {
    this.store = store;
    this._listeners = new Set();
    this._pendingCommands = [];
    this._lastEdgeSeenAt = null;
  }

  getStatus() {
    return {
      connectedClients: this._listeners.size,
      pendingCommands: this._pendingCommands.length,
      lastEdgeSeenAt: this._lastEdgeSeenAt,
    };
  }

  markEdgeSeen() {
    this._lastEdgeSeenAt = new Date().toISOString();
  }

  getSnapshot() {
    this.markEdgeSeen();
    const today = fitnessToday();
    const plans = this.store.all(
      `SELECT id, name, duration_days, price_cents, allowed_start_time, allowed_end_time, weekly_limit, active
       FROM plans ORDER BY id ASC`,
    );
    const members = this.store.all(
      `SELECT id, name, document, phone, birth_date, manual_access, access_role,
              plan_id, status, valid_until, controlid_user_id, face_registered,
              partner_provider, wellhub_id, frozen_until, frozen_started_at,
              is_visitor, visitor_expires_at, updated_at
       FROM members ORDER BY id ASC`,
    );
    const partnerCheckins = this.store.all(
      `SELECT provider, member_id, identifier, checkin_date, source, status, external_id, created_at
       FROM partner_checkins
       WHERE checkin_date = ?
       ORDER BY id ASC`,
      [today],
    );
    const allSettings = this.store.getSettings();
    const settings = {};
    for (const key of EDGE_SAFE_SETTINGS) {
      if (allSettings[key] !== undefined) settings[key] = allSettings[key];
    }
    return {
      serverTime: new Date().toISOString(),
      today,
      plans,
      members,
      partnerCheckins,
      settings,
    };
  }

  ingestLogs(logs = []) {
    this.markEdgeSeen();
    if (!Array.isArray(logs) || logs.length === 0) return { inserted: 0 };
    let inserted = 0;
    this.store.transaction(() => {
      for (const item of logs) {
        const edgeEventId = String(item?.edge_event_id || '').trim();
        if (!edgeEventId) continue;
        const exists = this.store.get(
          'SELECT id FROM access_logs WHERE edge_event_id = ?',
          [edgeEventId],
        );
        if (exists) continue;
        this.store.run(
          `INSERT INTO access_logs (
            controlid_log_id, controlid_user_id, member_id, member_name,
            event_code, event_label, occurred_at, edge_event_id, edge_synced
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            item.controlid_log_id != null ? Number(item.controlid_log_id) : null,
            item.controlid_user_id != null ? Number(item.controlid_user_id) : null,
            item.member_id != null ? Number(item.member_id) : null,
            item.member_name || null,
            item.event_code != null ? Number(item.event_code) : null,
            String(item.event_label || 'Acesso'),
            String(item.occurred_at || new Date().toISOString()),
            edgeEventId,
          ],
        );
        inserted += 1;
      }
    });
    return { inserted };
  }

  enqueueCommand(type, payload = {}) {
    const cmd = {
      id: randomUUID(),
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    if (type === 'release') {
      this._pendingCommands.push(cmd);
      if (this._pendingCommands.length > 50) {
        this._pendingCommands.shift();
      }
    }
    for (const listener of this._listeners) {
      try {
        listener(cmd);
      } catch {
        // ignore broken SSE listener
      }
    }
    return cmd;
  }

  ackCommand(commandId) {
    if (!commandId) return false;
    const before = this._pendingCommands.length;
    this._pendingCommands = this._pendingCommands.filter((c) => c.id !== commandId);
    return this._pendingCommands.length < before;
  }

  subscribeCommands(listener) {
    this.markEdgeSeen();
    this._listeners.add(listener);
    for (const cmd of this._pendingCommands) {
      try {
        listener(cmd);
      } catch {
        // ignore
      }
    }
    return () => {
      this._listeners.delete(listener);
    };
  }
}

export class EdgeSyncClient {
  constructor({
    store,
    accessService,
    cloudUrl,
    token,
    fetchFn = fetch,
    syncIntervalMs = 30000,
    reconnectDelayMs = 5000,
  }) {
    this.store = store;
    this.accessService = accessService;
    this.cloudUrl = String(cloudUrl || '').replace(/\/+$/, '');
    this.token = String(token || '').trim();
    this.fetchFn = fetchFn;
    this.syncIntervalMs = syncIntervalMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this._stopped = false;
    this._syncTimer = null;
    this._reconnectTimer = null;
    this._abortController = null;
    this._syncing = false;
    this.lastSyncAt = null;
    this.lastError = null;
  }

  _headers(extra = {}) {
    return {
      'X-Edge-Token': this.token,
      ...extra,
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.members)) return;
    this.store.transaction(() => {
      for (const p of snapshot.plans || []) {
        this.store.run(
          `INSERT INTO plans (id, name, duration_days, price_cents, allowed_start_time, allowed_end_time, weekly_limit, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             duration_days = excluded.duration_days,
             price_cents = excluded.price_cents,
             allowed_start_time = excluded.allowed_start_time,
             allowed_end_time = excluded.allowed_end_time,
             weekly_limit = excluded.weekly_limit,
             active = excluded.active`,
          [
            Number(p.id),
            String(p.name || 'Plano'),
            Number(p.duration_days || 30),
            Number(p.price_cents || 0),
            p.allowed_start_time || null,
            p.allowed_end_time || null,
            p.weekly_limit != null ? Number(p.weekly_limit) : null,
            p.active != null ? Number(p.active) : 1,
          ],
        );
      }

      const incomingIds = new Set();
      for (const m of snapshot.members || []) {
        const id = Number(m.id);
        incomingIds.add(id);
        this.store.run(
          `INSERT INTO members (
            id, name, document, phone, birth_date, manual_access, access_role,
            plan_id, status, valid_until, controlid_user_id, face_registered,
            partner_provider, wellhub_id, frozen_until, frozen_started_at,
            is_visitor, visitor_expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')))
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            document = excluded.document,
            phone = excluded.phone,
            birth_date = excluded.birth_date,
            manual_access = excluded.manual_access,
            access_role = excluded.access_role,
            plan_id = excluded.plan_id,
            status = excluded.status,
            valid_until = excluded.valid_until,
            controlid_user_id = excluded.controlid_user_id,
            face_registered = excluded.face_registered,
            partner_provider = excluded.partner_provider,
            wellhub_id = excluded.wellhub_id,
            frozen_until = excluded.frozen_until,
            frozen_started_at = excluded.frozen_started_at,
            is_visitor = excluded.is_visitor,
            visitor_expires_at = excluded.visitor_expires_at,
            updated_at = excluded.updated_at`,
          [
            id,
            String(m.name || 'Aluno'),
            m.document || null,
            m.phone || null,
            m.birth_date || null,
            Number(m.manual_access || 0),
            String(m.access_role || 'student'),
            m.plan_id != null ? Number(m.plan_id) : null,
            String(m.status || 'inactive'),
            m.valid_until || null,
            m.controlid_user_id != null ? Number(m.controlid_user_id) : null,
            Number(m.face_registered || 0),
            m.partner_provider || null,
            m.wellhub_id || null,
            m.frozen_until || null,
            m.frozen_started_at || null,
            Number(m.is_visitor || 0),
            m.visitor_expires_at || null,
            m.updated_at || null,
          ],
        );
      }

      if (snapshot.today && Array.isArray(snapshot.partnerCheckins)) {
        this.store.run('DELETE FROM partner_checkins WHERE checkin_date = ?', [snapshot.today]);
        for (const c of snapshot.partnerCheckins) {
          this.store.run(
            `INSERT OR IGNORE INTO partner_checkins (provider, member_id, identifier, checkin_date, source, status, external_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')))`,
            [
              String(c.provider),
              c.member_id != null ? Number(c.member_id) : null,
              String(c.identifier || ''),
              String(c.checkin_date),
              String(c.source || 'sync'),
              String(c.status || 'validated'),
              c.external_id || null,
              c.created_at || null,
            ],
          );
        }
      }
    });

    if (snapshot.settings && typeof snapshot.settings === 'object') {
      const safePatch = {};
      for (const key of EDGE_SAFE_SETTINGS) {
        if (snapshot.settings[key] !== undefined) {
          safePatch[key] = String(snapshot.settings[key]);
        }
      }
      if (Object.keys(safePatch).length > 0) {
        this.store.updateSettings(safePatch);
      }
    }
  }

  async pullSnapshot() {
    if (!this.cloudUrl || !this.token) return false;
    const res = await this.fetchFn(`${this.cloudUrl}/api/edge/snapshot`, {
      method: 'GET',
      headers: this._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Falha ao baixar snapshot (${res.status})`);
    }
    const snapshot = await res.json();
    this.applySnapshot(snapshot);
    this.lastSyncAt = new Date().toISOString();
    this.lastError = null;
    return true;
  }

  async pushPendingLogs() {
    if (!this.cloudUrl || !this.token) return { pushed: 0 };
    const pending = this.store.all(
      `SELECT id, controlid_log_id, controlid_user_id, member_id, member_name,
              event_code, event_label, occurred_at, edge_event_id
       FROM access_logs
       WHERE COALESCE(edge_synced, 0) = 0
       ORDER BY id ASC
       LIMIT 100`,
    );
    if (pending.length === 0) return { pushed: 0 };

    const payloadLogs = pending.map((row) => {
      const eventId = row.edge_event_id || `edge-${row.id}-${row.occurred_at}`;
      if (!row.edge_event_id) {
        this.store.run('UPDATE access_logs SET edge_event_id = ? WHERE id = ?', [eventId, row.id]);
      }
      return {
        ...row,
        edge_event_id: eventId,
      };
    });

    const res = await this.fetchFn(`${this.cloudUrl}/api/edge/logs`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ logs: payloadLogs }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Falha ao enviar logs (${res.status})`);
    }
    const ids = pending.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    this.store.run(`UPDATE access_logs SET edge_synced = 1 WHERE id IN (${placeholders})`, ids);
    return { pushed: pending.length };
  }

  async syncOnce() {
    if (this._syncing) return;
    this._syncing = true;
    try {
      await this.pushPendingLogs();
      await this.pullSnapshot();
    } catch (err) {
      this.lastError = err.message;
    } finally {
      this._syncing = false;
    }
  }

  async _handleCommand(cmd) {
    if (!cmd || !cmd.type) return;
    if (cmd.type === 'release') {
      const direction = cmd.payload?.direction || null;
      const turnstileId = cmd.payload?.turnstileId || null;
      try {
        await this.accessService.releaseTurnstile(direction, 'LIBERADO', { turnstileId });
        if (cmd.id) {
          await this.fetchFn(`${this.cloudUrl}/api/edge/commands/ack`, {
            method: 'POST',
            headers: this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: cmd.id }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        }
      } catch (err) {
        this.lastError = `Erro ao executar liberação remota: ${err.message}`;
      }
      return;
    }
    if (cmd.type === 'sync_needed') {
      await this.syncOnce();
    }
  }

  async _connectCommandStream() {
    if (this._stopped || !this.cloudUrl || !this.token) return;
    this._abortController = new AbortController();
    try {
      const res = await this.fetchFn(`${this.cloudUrl}/api/edge/commands`, {
        method: 'GET',
        headers: this._headers({ Accept: 'text/event-stream' }),
        signal: this._abortController.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Stream de comandos indisponível (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this._stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (dataLine) {
            try {
              const cmd = JSON.parse(dataLine.slice(5).trim());
              await this._handleCommand(cmd);
            } catch {
              // ignore malformed SSE frame
            }
          }
        }
      }
    } catch (err) {
      if (!this._stopped && err?.name !== 'AbortError') {
        this.lastError = err.message;
      }
    } finally {
      this._abortController = null;
      if (!this._stopped) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._connectCommandStream();
        }, this.reconnectDelayMs);
        this._reconnectTimer.unref?.();
      }
    }
  }

  start() {
    if (!this.cloudUrl || !this.token) return;
    this._stopped = false;
    this.syncOnce();
    this._syncTimer = setInterval(() => {
      this.syncOnce();
    }, this.syncIntervalMs);
    this._syncTimer.unref?.();
    this._connectCommandStream();
  }

  stop() {
    this._stopped = true;
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch {}
      this._abortController = null;
    }
  }
}
