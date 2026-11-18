import fs from 'node:fs';
import path from 'node:path';
import { GymService } from './gymService.js';
import { PartnerService, normalizePartnerInput } from './partnerService.js';
import { DeviceService } from './deviceService.js';
import { matchesDeviceIdentity } from './controlIdClient.js';
import { fitnessToday, weeklyGoal, weeklyVisits, receptionFitnessSummary } from './fitnessProgress.js';

function withoutPortalCredentials(member) {
  if (!member) return member;
  const { portal_password_hash, portal_invite_hash, portal_invite_expires_at, ...safe } = member;
  return safe;
}

const ACCESS_ROLES = ['student', 'user', 'instructor', 'staff'];

const EVENT_LABELS = {
  1: 'Equipamento inválido',
  2: 'Parâmetros inválidos',
  3: 'Não identificado',
  4: 'Identificação pendente',
  5: 'Tempo esgotado',
  6: 'Acesso negado',
  7: 'Acesso autorizado',
  8: 'Acesso pendente',
  11: 'Acesso por botoeira',
  12: 'Acesso por interface web',
  13: 'Desistência de passagem',
};

function addDays(isoDate, days) {
  const base = new Date(`${isoDate}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export class AccessService {
  constructor(store, controlId, toletus = null) {
    this.store = store;
    this.controlId = controlId;
    this.toletus = toletus;
    this.turnstileDisplay = null;
    this.turnstileDisplayId = 0;
    this.faceMirrorState = null;
    this._turnstileListeners = new Set();
    this._turnstileDeniedListeners = new Set();
    this._faceInFlight = new Map();
    this._verifiedDeviceUsers = new Map();
    this._capacityLock = Promise.resolve();
  }

  async _withCapacityLock(fn) {
    const prev = this._capacityLock;
    let release;
    this._capacityLock = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  _invalidateDeviceUserCache(deviceId = null) {
    if (deviceId != null) {
      this._verifiedDeviceUsers.delete(Number(deviceId));
      return;
    }
    this._verifiedDeviceUsers.clear();
  }

  _getSecondaryControlIdClients() {
    if (typeof this.controlId?.forDevice !== 'function') return [];
    const primaryCfg = this.controlId.getConfig?.() || {};
    const settings = this.store.getSettings?.() || {};
    const primaryIp = String(primaryCfg.ip || settings.controlid_ip || '').trim();
    const primaryPort = Number(primaryCfg.port || settings.controlid_port || 80);
    const rows = this.store.all("SELECT * FROM readers WHERE active = 1 AND COALESCE(brand, 'controlid') = 'controlid' ORDER BY id ASC");
    if (rows.length <= 1) return [];
    return rows
      .slice(1)
      .filter((r) => !(String(r.ip || '').trim() === primaryIp && Number(r.port || 80) === primaryPort))
      .map((r) => ({ reader: r, client: this.controlId.forDevice(r) }));
  }

  getTurnstileDisplay() {
    const event = this.turnstileDisplay;
    const remainingMs = event ? event.expiresAt - Date.now() : 0;
    if (remainingMs <= 0) return null;
    const { expiresAt, ...display } = event;
    return { ...display, remainingMs };
  }

  setFaceMirror({ active = false, memberName = null, frame = null, captured = false } = {}) {
    if (!active) {
      this.faceMirrorState = null;
      return null;
    }
    const safeFrame = typeof frame === 'string' &&
      /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(frame) &&
      frame.length <= 250_000
      ? frame
      : null;
    if (!safeFrame) return this.faceMirrorState;
    this.faceMirrorState = {
      active: true,
      memberName: memberName ? String(memberName).trim().slice(0, 80) : null,
      frame: safeFrame,
      captured: Boolean(captured),
      updatedAt: Date.now(),
    };
    return this.faceMirrorState;
  }

  getFaceMirror() {
    if (!this.faceMirrorState) return null;
    if (Date.now() - this.faceMirrorState.updatedAt > 15000) {
      this.faceMirrorState = null;
      return null;
    }
    return this.faceMirrorState;
  }

  getTurnstileKioskDisplay() {
    const base = this.getTurnstileDisplay();
    if (!base) {
      const mirror = this.getFaceMirror();
      return mirror ? { outcome: 'face_mirror', ...mirror } : null;
    }
    const extra = this.turnstileDisplayKioskExtra?.id === base.id ? this.turnstileDisplayKioskExtra : {};
    return { ...base, ...extra };
  }

  _buildKioskExtra(id, outcome, { member = null, today = fitnessToday(), preview = false } = {}) {
    const occ = this.getCurrentOccupancy();
    const extra = {
      id,
      totalMs: outcome === 'allowed' && !preview ? 8000 : 6000,
      occupancyInfo: { count: occ.count, maxCapacity: occ.maxCapacity },
    };
    if (!member) return extra;

    const firstName = String(member.name || '').trim().split(/\s+/, 1)[0] || null;
    extra.firstName = firstName;
    extra.fullName = member.name || null;
    extra.photo = member.profile_photo || null;
    extra.accessRole = member.access_role || 'student';

    if (preview && outcome === 'allowed') {
      extra.planName = 'Plano Mensal';
      extra.daysRemaining = 4;
      extra.inGrace = false;
      extra.workoutSummary = { title: 'Treino A — Superiores', goal: 'Hipertrofia', exerciseCount: 6 };
      return extra;
    }

    if (member.id) {
      if (!extra.photo && !('profile_photo' in member)) {
        extra.photo = this.store.get('SELECT profile_photo FROM members WHERE id = ?', [member.id])?.profile_photo || null;
      }
      if (!extra.photo) {
        try {
          const photoPath = this.getPhotoPath(member.id, member);
          if (photoPath && fs.existsSync(photoPath)) {
            const buf = fs.readFileSync(photoPath);
            if (buf.length > 0 && buf.length <= 1024 * 1024) {
              extra.photo = `data:image/jpeg;base64,${buf.toString('base64')}`;
            }
          }
        } catch {}
      }
      const enrollment = this.getPlanEnrollment(member.id);
      const validUntil = enrollment?.ends_on || member.valid_until || null;
      const planName = enrollment?.plan_name || member.plan_name || null;
      extra.planName = planName;
      extra.validUntil = validUntil;
      if (validUntil && /^\d{4}-\d{2}-\d{2}/.test(validUntil)) {
        const d1 = new Date(`${today}T12:00:00Z`);
        const d2 = new Date(`${validUntil.slice(0, 10)}T12:00:00Z`);
        const diffDays = Math.round((d2 - d1) / 86400000);
        extra.daysRemaining = diffDays;
        extra.inGrace = Boolean(diffDays < 0 && outcome === 'allowed');
      }
      const wk = this.store.get(
        'SELECT id, title, goal FROM workouts WHERE member_id = ? AND active = 1 ORDER BY id DESC LIMIT 1',
        [member.id],
      );
      if (wk) {
        const exCount = this.store.get('SELECT COUNT(*) AS c FROM workout_exercises WHERE workout_id = ?', [wk.id])?.c || 0;
        extra.workoutSummary = { title: wk.title, goal: wk.goal || null, exerciseCount: exCount };
      }
    }
    return extra;
  }

  getCurrentOccupancy() {
    const today = fitnessToday();
    const rows = this.store.all(
      `SELECT l.member_id, m.name, COUNT(*) AS passes
       FROM access_logs l
       JOIN members m ON m.id = l.member_id
       WHERE l.event_code = 7 AND l.member_id IS NOT NULL AND substr(l.occurred_at, 1, 10) = ?
       GROUP BY l.member_id
       HAVING (COUNT(*) % 2) = 1
       ORDER BY m.name ASC`,
      [today],
    );
    const maxCap = Number(this.store.getSettings()?.max_capacity || 0) || 0;
    return {
      count: rows.length,
      maxCapacity: maxCap > 0 ? maxCap : null,
      members: rows.map((r) => ({ id: r.member_id, name: r.name })),
    };
  }

  onTurnstileRelease(listener) {
    if (typeof listener !== 'function') return () => {};
    this._turnstileListeners.add(listener);
    return () => this._turnstileListeners.delete(listener);
  }

  onTurnstileDenied(listener) {
    if (typeof listener !== 'function') return () => {};
    this._turnstileDeniedListeners.add(listener);
    return () => this._turnstileDeniedListeners.delete(listener);
  }

  publishTurnstileDisplay(outcome, { member = null, reason = null, preview = false, progress = null, occupancy = null, source = null } = {}) {
    const today = fitnessToday();
    const maxCap = Number(this.store.getSettings()?.max_capacity || 0);
    const display = {
      id: ++this.turnstileDisplayId,
      outcome,
      expiresAt: Date.now() + (outcome === 'allowed' && !preview ? 8000 : 6000),
    };
    if (occupancy != null || maxCap > 0) {
      display.occupancy = occupancy ?? this.getCurrentOccupancy().count;
    }

    if (outcome === 'allowed' && member) {
      display.firstName = member.name.trim().split(/\s+/, 1)[0];
      if (typeof member.birth_date === 'string' && member.birth_date.length >= 10 && member.birth_date.slice(5, 10) === today.slice(5, 10)) {
        display.isBirthday = true;
      }
    }
    if (outcome === 'denied' && reason) display.reason = reason;
    if (progress) display.progress = progress;
    if (preview) display.preview = true;

    this.turnstileDisplay = display;
    this.turnstileDisplayKioskExtra = this._buildKioskExtra(display.id, outcome, { member, today, preview });

    if (outcome === 'allowed' && !preview && this._turnstileListeners.size > 0) {
      const releaseEvent = {
        id: display.id,
        memberId: member?.id || null,
        memberName: member?.name || 'Recepção (liberação manual)',
        accessRole: member?.access_role || (member ? 'student' : 'manual'),
        source: source || (member ? 'FaceID' : 'Liberação manual'),
        occurredAt: new Date().toISOString(),
        isBirthday: Boolean(display.isBirthday),
      };
      for (const listener of this._turnstileListeners) {
        try {
          listener(releaseEvent);
        } catch {
          // Listener failure must not break turnstile release.
        }
      }
    }

    if (outcome === 'denied' && !preview && this._turnstileDeniedListeners.size > 0) {
      const deniedEvent = {
        id: display.id,
        memberId: member?.id || null,
        memberName: member?.name || 'Não identificado',
        reason: reason || 'Acesso negado',
        source: source || 'FaceID',
        occurredAt: new Date().toISOString(),
      };
      for (const listener of this._turnstileDeniedListeners) {
        try {
          listener(deniedEvent);
        } catch {
          // Listener failure must not break turnstile denial.
        }
      }
    }
  }

  previewTurnstileDisplay(outcome) {
    if (!['idle', 'allowed', 'denied', 'unrecognized', 'error', 'offline'].includes(outcome)) {
      throw new Error('Selecione um estado para testar.');
    }
    if (this.getTurnstileDisplay() && !this.turnstileDisplay.preview) {
      throw Object.assign(new Error('Aguarde a mensagem da passagem atual terminar.'), { statusCode: 409 });
    }
    this.publishTurnstileDisplay(outcome, {
      member: { name: 'João' },
      reason: 'Matrícula vencida',
      preview: true,
    });
  }

  getDashboardSummary() {
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonthStart = this.store.get("SELECT date(?, '+1 month') AS nextMonth", [monthStart]).nextMonth;
    const tomorrow = this.store.get("SELECT date(?, '+1 day') AS tomorrow", [today]).tomorrow;

    const counts = new Map(this.store.all(`SELECT CASE
      WHEN m.access_role <> 'student' THEN 'team'
      WHEN m.partner_provider IN ('wellhub', 'totalpass') THEN CASE WHEN m.status = 'blocked' THEN 'blocked' ELSE 'active' END
      WHEN m.status = 'blocked' OR e.ends_on < ? THEN 'blocked'
      WHEN p.id IS NULL OR e.ends_on IS NULL THEN 'pending' ELSE m.status END AS status, COUNT(*) AS count
      FROM members m LEFT JOIN plan_enrollments e ON e.member_id = m.id LEFT JOIN plans p ON p.id = e.plan_id
      GROUP BY 1`, [this.enrollmentCutoff(today)]).map((row) => [row.status, row.count]));

    const revenueToday =
      this.store.get(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?",
        [today, tomorrow],
      )?.total ?? 0;

    const revenueMonth =
      this.store.get(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?",
        [monthStart, nextMonthStart],
      )?.total ?? 0;

    const recentLogs = this.store.all('SELECT * FROM access_logs ORDER BY id DESC LIMIT 10');
    const operation = this.store.get(`SELECT
      (SELECT COUNT(*) FROM members m JOIN plan_enrollments e ON e.member_id = m.id
        WHERE m.access_role = 'student' AND (m.partner_provider IS NULL OR m.partner_provider NOT IN ('wellhub', 'totalpass')) AND e.ends_on < ?) AS expiredEnrollments,
      (SELECT COUNT(*) FROM membership_charges c JOIN members m ON m.id = c.member_id
        WHERE m.access_role = 'student' AND (m.partner_provider IS NULL OR m.partner_provider NOT IN ('wellhub', 'totalpass')) AND c.payment_id IS NULL AND c.due < ?) AS overdueCharges,
      (SELECT COUNT(*) FROM products WHERE active = 1 AND stock <= 5) AS lowStock,
      (SELECT COUNT(*) FROM classes) AS classes,
      (SELECT COUNT(*) FROM access_logs WHERE event_code IN (7, 11, 12) AND occurred_at >= ? AND occurred_at < ?) AS allowedToday,
      (SELECT COUNT(*) FROM access_logs WHERE event_code IN (3, 6) AND occurred_at >= ? AND occurred_at < ?) AS deniedToday,
      (SELECT COALESCE(SUM(total_cents), 0) FROM sales WHERE sold_at >= ? AND sold_at < ?) AS salesTodayCents,
      (SELECT COALESCE(SUM(total_cents), 0) FROM sales WHERE sold_at >= ? AND sold_at < ?) AS salesMonthCents`,
    [today, today, today, tomorrow, today, tomorrow, today, tomorrow, monthStart, nextMonthStart]);

    return {
      activeMembers: counts.get('active') ?? 0,
      blockedMembers: counts.get('blocked') ?? 0,
      pendingMembers: counts.get('pending') ?? 0,
      teamMembers: counts.get('team') ?? 0,
      revenueTodayCents: revenueToday,
      revenueMonthCents: revenueMonth,
      recentLogs,
      ...operation,
      fitness: receptionFitnessSummary(this.store),
    };
  }

  listPlans() {
    return this.store.all('SELECT * FROM plans ORDER BY duration_days ASC');
  }

  _normalizePlanRules({ allowed_start_time, allowed_end_time, weekly_limit } = {}) {
    const timeOrNull = (val) => {
      if (val == null || String(val).trim() === '') return null;
      const clean = String(val).trim();
      if (!/^\d{2}:\d{2}$/.test(clean)) throw new Error('Horário permitido inválido. Use o formato HH:MM.');
      const [hh, mm] = clean.split(':').map(Number);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) throw new Error('Horário permitido inválido.');
      return clean;
    };
    const startTime = timeOrNull(allowed_start_time);
    const endTime = timeOrNull(allowed_end_time);
    let limit = null;
    if (weekly_limit != null && weekly_limit !== '') {
      const parsed = Number(weekly_limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 7) {
        throw new Error('Limite semanal deve ser entre 1 e 7.');
      }
      limit = parsed;
    }
    return { allowed_start_time: startTime, allowed_end_time: endTime, weekly_limit: limit };
  }

  createPlan({ name, duration_days, price_cents, allowed_start_time = null, allowed_end_time = null, weekly_limit = null }) {
    if (!name || !duration_days || price_cents === undefined) {
      throw new Error('Nome, duracao e valor do plano sao obrigatorios.');
    }
    const rules = this._normalizePlanRules({ allowed_start_time, allowed_end_time, weekly_limit });
    const res = this.store.run(
      'INSERT INTO plans (name, duration_days, price_cents, allowed_start_time, allowed_end_time, weekly_limit) VALUES (?, ?, ?, ?, ?, ?)',
      [name.trim(), Number(duration_days), Number(price_cents), rules.allowed_start_time, rules.allowed_end_time, rules.weekly_limit],
    );
    return this.store.get('SELECT * FROM plans WHERE id = ?', [res.lastInsertRowid]);
  }

  updatePlan(id, { name, duration_days, price_cents, allowed_start_time, allowed_end_time, weekly_limit }) {
    const existing = this.store.get('SELECT * FROM plans WHERE id = ?', [Number(id)]);
    if (!existing) throw new Error('Plano nao encontrado.');
    const trimmedName = String(name || '').trim();
    const days = Number(duration_days);
    const cents = Number(price_cents);
    if (!trimmedName || !Number.isFinite(days) || days <= 0 || !Number.isFinite(cents) || cents <= 0) {
      throw new Error('Nome, duracao (> 0) e valor (> 0) do plano sao obrigatorios.');
    }
    const rules = this._normalizePlanRules({
      allowed_start_time: allowed_start_time !== undefined ? allowed_start_time : existing.allowed_start_time,
      allowed_end_time: allowed_end_time !== undefined ? allowed_end_time : existing.allowed_end_time,
      weekly_limit: weekly_limit !== undefined ? weekly_limit : existing.weekly_limit,
    });
    this.store.run(
      'UPDATE plans SET name = ?, duration_days = ?, price_cents = ?, allowed_start_time = ?, allowed_end_time = ?, weekly_limit = ? WHERE id = ?',
      [trimmedName, days, cents, rules.allowed_start_time, rules.allowed_end_time, rules.weekly_limit, Number(id)],
    );
    return this.store.get('SELECT * FROM plans WHERE id = ?', [Number(id)]);
  }

  deletePlan(id) {
    const planId = Number(id);
    const existing = this.store.get('SELECT * FROM plans WHERE id = ?', [planId]);
    if (!existing) throw new Error('Plano nao encontrado.');

    const checks = [
      'SELECT 1 AS used FROM members WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM plan_enrollments WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM payments WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM gateway_charges WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM mp_subscriptions WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM point_orders WHERE plan_id = ? LIMIT 1',
      'SELECT 1 AS used FROM enrollment_cancellations WHERE plan_id = ? LIMIT 1',
    ];
    for (const sql of checks) {
      const hit = this.store.get(sql, [planId]);
      if (hit) {
        throw new Error('Plano em uso por alunos ou pagamentos. Edite o plano ou desvincule antes de excluir.');
      }
    }

    this.store.run('DELETE FROM plans WHERE id = ?', [planId]);
    return { deleted: true, id: planId };
  }

  listMembers(search = '', { summary = false } = {}) {
    const q = `%${search.trim()}%`;
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const fields = summary
      ? `m.id, m.name, m.document, m.phone, m.access_role, m.partner_provider, m.wellhub_id,
        CASE WHEN m.access_role = 'student' THEN e.plan_id END AS plan_id, m.status,
        CASE WHEN m.access_role = 'student' THEN e.ends_on END AS valid_until,
        CASE WHEN m.access_role <> 'student' THEN 'active'
             WHEN m.partner_provider IN ('wellhub', 'totalpass') THEN CASE WHEN m.status = 'blocked' THEN 'blocked' ELSE 'active' END
             WHEN m.status = 'blocked' OR e.ends_on < ? THEN 'blocked'
             WHEN p.id IS NULL OR e.ends_on IS NULL THEN 'pending'
             ELSE m.status END AS access_status,
        CASE WHEN m.access_role = 'student' AND m.status = 'active' AND p.id IS NOT NULL
             AND e.ends_on BETWEEN ? AND date(?, '-1 day') THEN 1 ELSE 0 END AS in_grace,
        m.face_registered, m.last_sync_error, mod.name AS modality_name, p.name AS plan_name`
      : 'm.*, p.name AS plan_name, p.price_cents AS plan_price_cents, p.duration_days AS plan_duration_days';
    const members = this.store.all(
      `SELECT ${fields}
       FROM members m
       ${summary
         ? 'LEFT JOIN plan_enrollments e ON e.member_id = m.id LEFT JOIN plans p ON p.id = e.plan_id LEFT JOIN modalities mod ON mod.id = m.modality_id'
         : 'LEFT JOIN plans p ON p.id = m.plan_id'}
       WHERE m.name LIKE ? OR COALESCE(m.document, '') LIKE ? OR COALESCE(m.phone, '') LIKE ? OR COALESCE(m.wellhub_id, '') LIKE ?
       ORDER BY m.id DESC`,
      summary ? [this.enrollmentCutoff(today), this.enrollmentCutoff(today), today, q, q, q, q] : [q, q, q, q],
    );
    if (!summary) return members.map(withoutPortalCredentials);
    const nextCharges = new Map();
    for (const charge of this.store.all('SELECT id, member_id, due, amount FROM membership_charges WHERE payment_id IS NULL ORDER BY due, id')) {
      if (!nextCharges.has(charge.member_id)) nextCharges.set(charge.member_id, charge);
    }
    const openDebts = new Map();
    for (const row of this.store.all("SELECT member_id, SUM(amount_cents - paid_cents) AS total FROM member_debts WHERE status = 'open' GROUP BY member_id")) {
      openDebts.set(row.member_id, Number(row.total || 0));
    }
    for (const member of members) {
      const next = nextCharges.get(member.id);
      if (next) member.next_charge = next;
      member.open_debt_cents = openDebts.get(member.id) || 0;
    }
    return members;
  }

  getMember(id) {
    return withoutPortalCredentials(this.store.get(
      `SELECT m.*, p.name AS plan_name, p.price_cents AS plan_price_cents, p.duration_days AS plan_duration_days,
              COALESCE((SELECT SUM(amount_cents - paid_cents) FROM member_debts WHERE member_id = m.id AND status = 'open'), 0) AS open_debt_cents
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       WHERE m.id = ?`,
      [Number(id)],
    ));
  }

  async createMember({ name, document, phone, email, plan_id, modality_id, class_id, birth_date, sex, address, emergency_contact, notes, access_role = 'student', partner_provider = null, wellhub_id = null }) {
    if (!name?.trim()) {
      throw new Error('Nome do aluno e obrigatorio.');
    }
    if (!ACCESS_ROLES.includes(access_role)) throw new Error('Tipo de acesso inválido.');

    const memberId = this.store.transaction(() => {
      const gym = new GymService(this.store);
      gym.assertUniqueMemberName(name);
      const formattedDocument = gym.assertValidAndUniqueCpf(document);
      const partner = access_role === 'student'
        ? normalizePartnerInput({ partner_provider, wellhub_id })
        : { partner_provider: null, wellhub_id: null };
      if (partner.partner_provider === 'wellhub') {
        gym.assertUniqueWellhubId(partner.wellhub_id);
      }
      const modalityId = modality_id ? Number(modality_id) : null;
      const classId = class_id ? Number(class_id) : null;
      if (modalityId !== null || classId !== null) {
        gym.validateEnrollment(0, modalityId, classId);
      }
      const res = this.store.run(
        `INSERT INTO members (name, document, phone, email, plan_id, modality_id, birth_date, sex, address, emergency_contact, notes, access_role, partner_provider, wellhub_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name.trim(),
          formattedDocument,
          phone?.trim() || null,
          email?.trim() || null,
          partner.partner_provider ? null : (plan_id ? Number(plan_id) : null),
          modalityId,
          birth_date || null,
          sex || null,
          address?.trim() || null,
          emergency_contact?.trim() || null,
          notes?.trim() || null,
          access_role,
          partner.partner_provider,
          partner.wellhub_id,
          access_role === 'student' && !partner.partner_provider ? 'pending' : 'active',
        ],
      );
      const id = res.lastInsertRowid;
      if (classId !== null) this.store.run('INSERT INTO class_enrollments (class_id, member_id) VALUES (?, ?)', [classId, id]);
      this.store.run('UPDATE members SET controlid_user_id = ? WHERE id = ?', [id, id]);
      return id;
    });

    const member = this.getMember(memberId);
    await this.trySyncMemberToDevice(member);
    return this.getMember(memberId);
  }

  setEdgeCloudHub(hub) {
    this.edgeCloudHub = hub || null;
  }

  async trySyncMemberToDevice(member) {
    if (String(process.env.EDGE_ROLE || '').trim().toLowerCase() === 'cloud') {
      this.edgeCloudHub?.enqueueCommand('sync_needed', { memberId: member?.id || null });
      return { synced: true, deferredToEdge: true };
    }
    const allowed = !this.getAccessDenial(member);
    try {
      const deviceId = member.controlid_user_id || member.id;
      this._invalidateDeviceUserCache(deviceId);
      if (this.store.get('SELECT id FROM members WHERE controlid_user_id = ? AND id <> ?', [deviceId, member.id])) {
        throw new Error('ID facial vinculado a outro cadastro. Confira o vínculo no perfil.');
      }
      const result = await this.controlId.syncMember(member, allowed);
      const syncedDeviceId = result?.controlIdUserId ?? deviceId;
      this.store.run(
        "UPDATE members SET controlid_user_id = COALESCE(controlid_user_id, ?), last_sync_error = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [syncedDeviceId, member.id],
      );
      const secondaryMember = { ...member, controlid_user_id: syncedDeviceId };
      for (const { client } of this._getSecondaryControlIdClients()) {
        try {
          await client.syncMember(secondaryMember, allowed);
        } catch {
          // Leitores secundários são sincronizados em regime best-effort
        }
      }
      return { synced: true };
    } catch (err) {
      this.store.run(
        "UPDATE members SET last_sync_error = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [err.message, member.id],
      );
      return { synced: false, error: err.message };
    }
  }

  async registerFace(memberId, imageBase64) {
    const member = this.getMember(memberId);
    if (!member) {
      throw new Error('Cliente nao encontrado.');
    }
    if (!imageBase64) {
      throw new Error('Imagem facial nao enviada.');
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (buffer.length === 0) {
      throw new Error('Imagem invalida.');
    }
    if (buffer.length > 1024 * 1024) {
      throw new Error('A foto facial deve ter no maximo 1 MB.');
    }

    if (String(process.env.EDGE_ROLE || '').trim().toLowerCase() === 'cloud') {
      const deviceUserId = member.controlid_user_id || member.id;
      this.saveLocalPhoto(member.id, buffer);
      this._saveProfilePhotoIfMissing(member.id, buffer);
      this.store.run(
        "UPDATE members SET controlid_user_id = COALESCE(controlid_user_id, ?), face_registered = 1, last_sync_error = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [deviceUserId, member.id],
      );
      this.edgeCloudHub?.enqueueCommand('register_face', { memberId: member.id, imageBase64 });
      return this.getMember(member.id);
    }

    const syncResult = await this.trySyncMemberToDevice(member);
    if (!syncResult.synced) {
      throw new Error(`Nao foi possivel sincronizar usuario com a catraca: ${syncResult.error}`);
    }

    const deviceUserId = member.controlid_user_id || member.id;
    this._invalidateDeviceUserCache(deviceUserId);
    await this.controlId.uploadUserFace(deviceUserId, buffer);

    for (const { client } of this._getSecondaryControlIdClients()) {
      try {
        await client.uploadUserFace(deviceUserId, buffer);
      } catch {
        // Leitores secundários recebem a face em regime best-effort
      }
    }

    this.saveLocalPhoto(member.id, buffer);
    this._saveProfilePhotoIfMissing(member.id, buffer);

    this.store.run(
      "UPDATE members SET face_registered = 1, last_sync_error = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [member.id],
    );

    return this.getMember(member.id);
  }

  async inspectDeviceLink(deviceId) {
    if (!Number.isSafeInteger(deviceId) || deviceId <= 0) throw new Error('Informe o ID do usuário no Control iD.');
    if (this.controlId.getConfig?.().mockMode) throw new Error('O vínculo facial requer conexão com o leitor.');
    const user = await this.controlId.getDeviceUser(deviceId);
    if (!user) throw new Error('Usuário não encontrado no Control iD.');
    const linked = this.store.all('SELECT id, name FROM members WHERE controlid_user_id = ? ORDER BY id', [deviceId]);
    return { id: deviceId, name: user.name, linked };
  }

  async relinkDevice(memberId, { device_id, expected_name, previous_ids }) {
    const id = Number(device_id);
    const reader = await this.inspectDeviceLink(id);
    if (reader.name !== expected_name || !Array.isArray(previous_ids) ||
        JSON.stringify(reader.linked.map((entry) => entry.id)) !== JSON.stringify(previous_ids)) {
      throw new Error('O vínculo mudou. Consulte o ID novamente.');
    }
    const member = this.getMember(memberId);
    if (!member) throw new Error('Cadastro não encontrado.');
    const user = await this.controlId.getDeviceUser(id);
    if (!user || user.name !== reader.name || !matchesDeviceIdentity(member, user)) {
      throw new Error('Nome ou CPF incompatível com o cadastro escolhido. Confira a identidade no leitor.');
    }
    this.store.transaction(() => {
      const current = this.store.all('SELECT id FROM members WHERE controlid_user_id = ? ORDER BY id', [id]);
      if (JSON.stringify(current.map((row) => row.id)) !== JSON.stringify(previous_ids)) throw new Error('O vínculo mudou. Consulte o ID novamente.');
      this.store.run(`UPDATE members SET controlid_user_id = NULL, face_registered = 0,
        last_sync_error = 'Vínculo facial removido para corrigir uma divergência' WHERE controlid_user_id = ? AND id <> ?`, [id, member.id]);
      this.store.run('UPDATE members SET controlid_user_id = ?, face_registered = 1, last_sync_error = NULL WHERE id = ?', [id, member.id]);
    });
    this._invalidateDeviceUserCache(id);
    return this.getMember(member.id);
  }

  async deleteMember(memberId) {
    const id = Number(memberId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('ID de cadastro inválido.');
    }
    const member = this.getMember(id);
    if (!member) {
      throw new Error('Cadastro não encontrado.');
    }

    const paymentCount = Number(this.store.get('SELECT COUNT(*) AS c FROM payments WHERE member_id = ?', [id])?.c || 0);
    const saleCount = Number(this.store.get('SELECT COUNT(*) AS c FROM sales WHERE member_id = ?', [id])?.c || 0);
    const paidGateway = Number(
      this.store.get("SELECT COUNT(*) AS c FROM gateway_charges WHERE member_id = ? AND status = 'paid'", [id])?.c || 0,
    );
    const paidPoint = Number(
      this.store.get("SELECT COUNT(*) AS c FROM point_orders WHERE member_id = ? AND status = 'paid'", [id])?.c || 0,
    );
    if (paymentCount > 0 || saleCount > 0 || paidGateway > 0 || paidPoint > 0) {
      throw new Error('Não é possível excluir aluno com pagamentos ou vendas registradas. Bloqueie ou inative o cadastro.');
    }

    const nullableLogTables = [
      'access_logs',
      'whatsapp_logs',
      'whatsapp_chats',
      'online_enrollment_requests',
      'payment_receipts',
    ];
    const childTables = [
      'class_enrollments',
      'member_modalities',
      'plan_enrollments',
      'membership_charges',
      'gateway_charges',
      'asaas_subscriptions',
      'point_orders',
      'mp_subscriptions',
      'enrollment_cancellations',
      'workouts',
      'member_credit_logs',
      'student_fitness_preferences',
      'student_workout_completions',
      'partner_checkins',
      'body_assessments',
      'class_bookings',
      'member_debts',
      'member_freezes',
    ];

    this.store.transaction(() => {
      for (const table of nullableLogTables) {
        this.store.run(`UPDATE ${table} SET member_id = NULL WHERE member_id = ?`, [id]);
      }
      for (const table of childTables) {
        this.store.run(`DELETE FROM ${table} WHERE member_id = ?`, [id]);
      }
      this.store.run('DELETE FROM members WHERE id = ?', [id]);
    });

    if (member.controlid_user_id && typeof this.controlId?.deleteUser === 'function') {
      const stillUsed = this.store.get(
        'SELECT id FROM members WHERE controlid_user_id = ? LIMIT 1',
        [member.controlid_user_id],
      );
      if (!stillUsed) {
        try {
          await this.controlId.deleteUser(member.controlid_user_id);
        } catch {
          // Best-effort quando o leitor não está acessível diretamente (ex.: modo cloud).
        }
      }
    }

    return { ok: true, id, name: member.name };
  }

  getPhotoPath(memberId, member = null) {
    if (!this.store.filePath) return null;
    const target = member && 'controlid_user_id' in member ? member : this.getMember(memberId);
    const deviceId = target?.controlid_user_id;
    if (!deviceId) return null;
    return path.join(path.dirname(this.store.filePath), 'photos', `${memberId}-${deviceId}.jpg`);
  }

  saveLocalPhoto(memberId, buffer) {
    const filePath = this.getPhotoPath(memberId);
    if (!filePath || !buffer?.length) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
  }

  _saveProfilePhotoIfMissing(memberId, buffer) {
    if (!buffer || buffer.length === 0 || buffer.length > 512 * 1024) return false;
    const row = this.store.get('SELECT profile_photo FROM members WHERE id = ?', [memberId]);
    if (!row || row.profile_photo) return false;
    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    this.store.run(
      "UPDATE members SET profile_photo = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND (profile_photo IS NULL OR profile_photo = '')",
      [dataUrl, memberId],
    );
    return true;
  }

  async getMemberPhoto(memberId) {
    const member = this.getMember(memberId);
    if (!member) return null;

    const filePath = this.getPhotoPath(member.id, member);
    if (filePath && fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      this._saveProfilePhotoIfMissing(member.id, buf);
      return buf;
    }

    if (member.face_registered && member.controlid_user_id && typeof this.controlId?.getUserImage === 'function') {
      if (this.controlId.getDeviceUser && !this.controlId.getConfig?.().mockMode) {
        const user = await this.controlId.getDeviceUser(member.controlid_user_id);
        if (!user || !matchesDeviceIdentity(member, user)) return null;
      }
      const buf = await this.controlId.getUserImage(member.controlid_user_id);
      if (buf) {
        this.saveLocalPhoto(member.id, buf);
        this._saveProfilePhotoIfMissing(member.id, buf);
        return buf;
      }
    }

    return null;
  }

  async collectMissingMemberPhotos({ limit = 3 } = {}) {
    if (!this._photoSyncAttempted) this._photoSyncAttempted = new Set();
    const candidates = this.store.all(
      `SELECT id FROM members
       WHERE face_registered = 1
         AND controlid_user_id IS NOT NULL
         AND (profile_photo IS NULL OR profile_photo = '')
       ORDER BY id ASC`,
    );
    const collected = [];
    for (const row of candidates) {
      if (collected.length >= limit) break;
      if (this._photoSyncAttempted.has(row.id)) continue;
      this._photoSyncAttempted.add(row.id);
      try {
        await this.getMemberPhoto(row.id);
        const updated = this.store.get('SELECT profile_photo FROM members WHERE id = ?', [row.id]);
        if (updated?.profile_photo) {
          collected.push({ id: row.id, profile_photo: updated.profile_photo });
        }
      } catch {
        // Ignora falha individual para continuar o lote
      }
    }
    return collected;
  }

  getPlanEnrollment(memberId) {
    return this.store.get(`SELECT e.*, p.name AS plan_name FROM plan_enrollments e
      LEFT JOIN plans p ON p.id = e.plan_id WHERE e.member_id = ?`, [memberId]);
  }

  enrollmentCutoff(today) {
    return addDays(today, -Math.max(0, Math.floor(Number(this.store.getSettings()?.tolerance_days) || 0)));
  }

  getEnrollmentDenial(enrollment, today = this.store.get("SELECT date('now', 'localtime') AS today").today) {
    if (!enrollment?.plan_name || !enrollment.ends_on) return 'Matrícula sem vigência';
    if (enrollment.ends_on < this.enrollmentCutoff(today)) return 'Matrícula vencida';
    return null;
  }

  getAccessDenial(member) {
    if (member.access_role !== 'student') return null;
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    if (member.frozen_until && member.frozen_until >= today) {
      return 'Matrícula trancada';
    }
    if (member.is_visitor) {
      if (member.status === 'blocked') return 'Acesso suspenso';
      if (!member.visitor_expires_at || member.visitor_expires_at.slice(0, 10) < today) {
        return 'Passe de visitante expirado';
      }
      return null;
    }
    if (member.partner_provider === 'wellhub' || member.partner_provider === 'totalpass') {
      if (member.status === 'blocked') return 'Acesso suspenso';
      const settings = this.store.getSettings();
      if (member.partner_provider === 'wellhub') {
        if (settings.wellhub_enabled === 'false') return 'Wellhub desativado';
        if (!member.wellhub_id?.trim()) return 'ID Wellhub não informado';
        if (settings.wellhub_require_checkin === '1' && !new PartnerService(this.store).hasCheckinToday(member.id, 'wellhub')) {
          return 'Check-in Wellhub pendente hoje';
        }
        return null;
      }
      if (settings.totalpass_enabled === 'false') return 'TotalPass desativado';
      if (!member.document?.trim()) return 'CPF TotalPass não informado';
      if (settings.totalpass_require_checkin === '1' && !new PartnerService(this.store).hasCheckinToday(member.id, 'totalpass')) {
        return 'Check-in TotalPass pendente hoje';
      }
      return null;
    }
    const enrollment = this.getPlanEnrollment(member.id);
    const baseDenial = this.getEnrollmentDenial(enrollment, today)
      || (member.status === 'active' ? null : member.status === 'pending' ? 'Cadastro pendente' : 'Acesso suspenso');
    if (baseDenial) return baseDenial;

    const planId = enrollment?.plan_id || member.plan_id;
    const plan = planId ? this.store.get('SELECT allowed_start_time, allowed_end_time, weekly_limit FROM plans WHERE id = ?', [planId]) : null;
    if (plan?.allowed_start_time && plan?.allowed_end_time) {
      const hhmm = this.store.get("SELECT strftime('%H:%M', 'now', 'localtime') AS hhmm").hhmm;
      const inWindow = plan.allowed_start_time <= plan.allowed_end_time
        ? (hhmm >= plan.allowed_start_time && hhmm <= plan.allowed_end_time)
        : (hhmm >= plan.allowed_start_time || hhmm <= plan.allowed_end_time);
      if (!inWindow) return 'Fora do horário permitido pelo plano';
    }
    if (plan?.weekly_limit && plan.weekly_limit > 0) {
      const date = fitnessToday();
      const visits = weeklyVisits(this.store, member.id, date);
      if (!visits.includes(date) && visits.length >= plan.weekly_limit) {
        return 'Limite semanal de treinos atingido';
      }
    }
    return null;
  }

  async setAccessRole(memberId, role) {
    if (!ACCESS_ROLES.includes(role)) throw new Error('Tipo de acesso inválido.');
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    if (member.access_role !== role) {
      const status = role !== 'student' ? 'active'
        : this.getEnrollmentDenial(this.getPlanEnrollment(member.id)) ? 'pending' : 'active';
      this.store.run('UPDATE members SET access_role = ?, status = ?, manual_access = 0 WHERE id = ?', [role, status, member.id]);
    }
    const updated = this.getMember(member.id);
    return { member: updated, sync: await this.trySyncMemberToDevice(updated) };
  }

  async savePlanEnrollment(memberId, { plan_id, starts_on }) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    if (member.access_role !== 'student') throw new Error('A equipe tem acesso permanente sem matrícula.');
    if (plan_id == null || plan_id === '') {
      this.store.transaction(() => {
        this.store.run(
          `UPDATE members SET plan_id = NULL, valid_until = NULL, status = 'pending', manual_access = 0,
           updated_at = datetime('now', 'localtime') WHERE id = ?`,
          [member.id],
        );
        this.store.run('DELETE FROM plan_enrollments WHERE member_id = ?', [member.id]);
        this.store.run('DELETE FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
      });
      const sync = await this.trySyncMemberToDevice(this.getMember(member.id));
      return { enrollment: null, charge: null, sync };
    }
    const plan = this.store.get('SELECT id, duration_days, price_cents FROM plans WHERE id = ?', [Number(plan_id)]);
    if (!plan || !Number.isInteger(plan.duration_days) || plan.duration_days <= 0) throw new Error('Selecione um plano válido.');
    const start = typeof starts_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(starts_on) ? new Date(starts_on + 'T12:00:00Z') : null;
    if (!start || !Number.isFinite(+start) || start.toISOString().slice(0, 10) !== starts_on) throw new Error('Informe a data de início da matrícula.');
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    if (starts_on > today) throw new Error('Informe uma data de início até hoje.');
    const endsOn = addDays(starts_on, plan.duration_days - 1);
    const chargeDue = starts_on >= addDays(today, -2) ? starts_on : today;
    let createdCharge = null;
    this.store.transaction(() => {
      this.store.run(`UPDATE members SET plan_id = ?, valid_until = ?, status = ?, manual_access = 0,
        updated_at = datetime('now', 'localtime') WHERE id = ?`, [plan.id, endsOn, endsOn >= this.enrollmentCutoff(today) ? 'active' : 'blocked', member.id]);
      this.store.run(`INSERT INTO plan_enrollments (member_id, plan_id, starts_on, ends_on)
        VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET starts_on = excluded.starts_on, ends_on = excluded.ends_on, plan_id = excluded.plan_id`,
      [member.id, plan.id, starts_on, endsOn]);

      if (!member.partner_provider && Number(plan.duration_days) > 1 && Number(plan.price_cents) > 0) {
        const openCharge = this.store.get(
          'SELECT id, due, amount FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due, id LIMIT 1',
          [member.id],
        );
        if (!openCharge && !this.store.get('SELECT id FROM membership_charges WHERE member_id = ? AND due = ?', [member.id, chargeDue])) {
          const ins = this.store.run(
            'INSERT INTO membership_charges (member_id, due, amount) VALUES (?, ?, ?)',
            [member.id, chargeDue, plan.price_cents],
          );
          createdCharge = { id: ins.lastInsertRowid, member_id: member.id, due: chargeDue, amount: plan.price_cents };
        }
      }
    });
    const sync = await this.trySyncMemberToDevice(this.getMember(member.id));
    return { enrollment: this.getPlanEnrollment(member.id), charge: createdCharge, sync };
  }

  deleteMembershipCharge(chargeId) {
    const id = Number(chargeId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('ID de cobrança inválido.');
    }
    const charge = this.store.get('SELECT id, member_id, due, amount, payment_id FROM membership_charges WHERE id = ?', [id]);
    if (!charge) {
      throw new Error('Cobrança não encontrada.');
    }
    if (charge.payment_id != null) {
      throw new Error('Esta cobrança já foi paga e não pode ser removida.');
    }
    this.store.run('DELETE FROM membership_charges WHERE id = ? AND payment_id IS NULL', [id]);
    return { ok: true, id, member_id: charge.member_id, due: charge.due, amount: charge.amount };
  }

  async setMemberStatus(memberId, status) {
    if (!['active', 'blocked', 'pending'].includes(status)) {
      throw new Error('Status invalido.');
    }
    const member = this.getMember(memberId);
    if (!member) {
      throw new Error('Cliente nao encontrado.');
    }
    if (member.access_role !== 'student') throw new Error('Altere o tipo de acesso para remover a permissão permanente da equipe.');

    const denial = status === 'active' && this.getEnrollmentDenial(this.getPlanEnrollment(member.id));
    if (denial) {
      throw new Error(`${denial}. Atualize o plano e a vigência da matrícula.`);
    }
    this.store.run(
      "UPDATE members SET status = ?, manual_access = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [status, status === 'blocked' ? 1 : 0, member.id],
    );

    const updated = this.getMember(member.id);
    const sync = await this.trySyncMemberToDevice(updated);
    return { member: this.getMember(member.id), sync };
  }

  listPayments(options = 100) {
    const opts = typeof options === 'number' ? { limit: options, q: '' } : (options || {});
    const limit = Math.min(300, Math.max(1, Number(opts.limit || 100)));
    const q = String(opts.q || '').trim();
    const params = [];
    let where = '';
    if (q) {
      where = 'WHERE m.name LIKE ? OR COALESCE(m.document, "") LIKE ?';
      params.push(`%${q}%`, `%${q}%`);
    }
    params.push(limit);
    return this.store.all(
      `SELECT pay.*, m.name AS member_name, m.document AS member_document, m.valid_until AS member_valid_until, p.name AS plan_name
       FROM payments pay
       JOIN members m ON m.id = pay.member_id
       LEFT JOIN plans p ON p.id = pay.plan_id
       ${where}
       ORDER BY pay.paid_at DESC, pay.id DESC
       LIMIT ?`,
      params,
    );
  }

  createMembershipCharge(memberId, { due, amount }) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Informe um vencimento válido.');
    const parsed = new Date(due + 'T12:00:00Z');
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== due) throw new Error('Informe um vencimento válido.');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Informe um valor maior que zero.');
    if (this.store.get('SELECT id FROM membership_charges WHERE member_id = ? AND due = ?', [member.id, due])) {
      throw new Error('Já existe uma mensalidade para esse vencimento.');
    }
    const { lastInsertRowid } = this.store.run(
      'INSERT INTO membership_charges (member_id, due, amount) VALUES (?, ?, ?)', [member.id, due, amount],
    );
    return { id: lastInsertRowid, member_id: member.id, due, amount };
  }

  normalizeSplitPayments(splitPayments) {
    if (!Array.isArray(splitPayments)) return null;
    const parts = [];
    for (const item of splitPayments) {
      const amount = Math.round(Number(item?.amount_cents ?? 0));
      if (!Number.isFinite(amount) || amount < 0) {
        throw Object.assign(new Error('Valor inválido nas formas de pagamento.'), { statusCode: 400 });
      }
      if (amount === 0) continue;
      const method = String(item?.method || '').trim();
      if (!method) {
        throw Object.assign(new Error('Selecione a forma de pagamento para cada valor informado.'), { statusCode: 400 });
      }
      parts.push({ method, amount_cents: amount });
    }
    return parts;
  }

  async recordPayment({ member_id, plan_id, amount_cents, method = 'pix', external_id = null, notes = null, charge_id = null, use_credit = false, credit_excess_cents = 0, staff_id = null, commission_cents = 0, split_payments = null, debt_cents = 0, debt_due_date = null, debt_notes = null },
    { requireOpenCash = false, reconcileOpenCharge = false, exactCharge = false, onRecorded = null } = {}) {
    const existing = external_id && this.store.get('SELECT * FROM payments WHERE external_id = ?', [external_id]);
    if (existing) {
      const creditUsed = this.store.get(
        'SELECT COALESCE(SUM(-delta_cents), 0) AS used FROM member_credit_logs WHERE payment_id = ?',
        [existing.id],
      )?.used || 0;
      const recordedGross = existing.amount_cents + creditUsed;
      if (existing.member_id !== Number(member_id) ||
          (amount_cents != null && existing.amount_cents !== Number(amount_cents) && recordedGross !== Number(amount_cents))) {
        throw Object.assign(new Error('Transação já registrada para outro cadastro ou valor.'), { statusCode: 409 });
      }
      if (onRecorded) this.store.transaction(() => onRecorded(existing.id));
      return { payment: existing, member: this.getMember(member_id), sync: null, alreadyRecorded: true };
    }
    const openCash = this.store.get("SELECT id FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    if (requireOpenCash && !openCash) {
      throw Object.assign(new Error('Caixa fechado. Abra o caixa para registrar o recebimento.'), {
        statusCode: 409, code: 'CASH_CLOSED',
      });
    }
    const member = this.getMember(member_id);
    if (!member) {
      throw new Error('Cliente nao encontrado.');
    }
    if (member.access_role !== 'student') throw new Error('Acesso da equipe não exige mensalidade.');

    const charge = this.store.get(
      'SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due, id LIMIT 1',
      [member.id],
    );
    const matchesOpen = reconcileOpenCharge && !exactCharge && charge && charge_id == null &&
      Number(amount_cents) === charge.amount && (!plan_id || Number(plan_id) === member.plan_id);
    if ((charge || charge_id) && Number(charge_id) !== charge?.id && !matchesOpen) {
      const err = new Error('Selecione a primeira mensalidade em aberto e atualize a tela se necessário.');
      err.statusCode = 409;
      throw err;
    }
    if (reconcileOpenCharge && charge && Number(amount_cents) !== charge.amount) {
      throw Object.assign(new Error('Valor confirmado difere da mensalidade. Confira a cobrança.'), { statusCode: 409 });
    }
    const chosenPlanId = charge ? member.plan_id : plan_id ? Number(plan_id) : member.plan_id;
    if (reconcileOpenCharge && charge && plan_id && Number(plan_id) !== member.plan_id) {
      throw Object.assign(new Error('O plano mudou desde a emissão da cobrança.'), { statusCode: 409 });
    }
    const plan = chosenPlanId ? this.store.get('SELECT * FROM plans WHERE id = ?', [chosenPlanId]) : null;
    if (!plan) throw new Error('Selecione um plano para registrar a mensalidade.');
    const finalAmount = exactCharge || reconcileOpenCharge
      ? (charge?.amount ?? (amount_cents !== undefined ? Number(amount_cents) : plan?.price_cents))
      : (amount_cents !== undefined ? Number(amount_cents) : (charge?.amount ?? plan?.price_cents));

    if (!Number.isSafeInteger(finalAmount) || finalAmount <= 0) {
      throw new Error('Valor do pagamento invalido.');
    }

    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const enrollment = this.getPlanEnrollment(member.id);
    const currentDue = [enrollment?.ends_on, member.valid_until]
      .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .pop() || null;
    const extendsCurrent = Boolean(currentDue && currentDue >= today);
    const newValidUntil = extendsCurrent
      ? addDays(currentDue, plan.duration_days)
      : addDays(today, plan.duration_days > 1 ? plan.duration_days : 0);

    const availableCredit = Number(member.credit_cents || 0);
    const creditUsedCents = use_credit && availableCredit > 0 ? Math.min(availableCredit, finalAmount) : 0;
    const netAmountCents = Math.max(0, finalAmount - creditUsedCents);

    const parsedSplits = this.normalizeSplitPayments(split_payments);
    const parsedDebtCents = Math.round(Number(debt_cents || 0));
    const parsedExcessCreditCents = Math.round(Number(credit_excess_cents || 0));
    if (!Number.isSafeInteger(parsedDebtCents) || parsedDebtCents < 0) {
      throw Object.assign(new Error('Valor de débito inválido.'), { statusCode: 400 });
    }
    if (!Number.isSafeInteger(parsedExcessCreditCents) || parsedExcessCreditCents < 0) {
      throw Object.assign(new Error('Valor de crédito excedente inválido.'), { statusCode: 400 });
    }
    if (parsedDebtCents > 0 && parsedExcessCreditCents > 0) {
      throw Object.assign(new Error('Não é possível registrar débito e crédito excedente simultaneamente.'), { statusCode: 400 });
    }
    if (reconcileOpenCharge && (parsedSplits !== null || parsedDebtCents > 0 || parsedExcessCreditCents > 0)) {
      throw Object.assign(new Error('Conciliação automática não suporta pagamento dividido, débito ou crédito excedente.'), { statusCode: 400 });
    }

    const usesSplitOrDebt = parsedSplits !== null || parsedDebtCents > 0;
    let paidParts;
    if (usesSplitOrDebt) {
      paidParts = parsedSplits !== null
        ? parsedSplits
        : (netAmountCents - parsedDebtCents > 0 ? [{ method, amount_cents: netAmountCents - parsedDebtCents }] : []);
      const sumPaid = paidParts.reduce((acc, p) => acc + p.amount_cents, 0);
      if (sumPaid + parsedDebtCents !== netAmountCents) {
        throw Object.assign(
          new Error(`Soma das formas de pagamento + débito (${((sumPaid + parsedDebtCents) / 100).toFixed(2)}) difere do total a cobrar (${(netAmountCents / 100).toFixed(2)}).`),
          { statusCode: 400 },
        );
      }
      if (paidParts.length === 0 && parsedDebtCents === 0 && creditUsedCents > 0) {
        paidParts = [{ method, amount_cents: 0 }];
      }
    } else {
      paidParts = [{ method, amount_cents: netAmountCents + parsedExcessCreditCents }];
    }

    const dueDateNorm = debt_due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(debt_due_date).trim())
      ? String(debt_due_date).trim()
      : null;

    const txResult = this.store.transaction(() => {
      const insertedPaymentIds = [];
      let primaryPaymentId = null;

      for (let i = 0; i < paidParts.length; i++) {
        const part = paidParts[i];
        const partNotesList = [notes];
        if (i === 0 && creditUsedCents > 0) {
          partNotesList.push(`Crédito utilizado: R$ ${(creditUsedCents / 100).toFixed(2).replace('.', ',')}`);
        }
        if (paidParts.length > 1) {
          partNotesList.push(`Pagamento misto (${i + 1}/${paidParts.length})`);
        }
        if (i === 0 && parsedDebtCents > 0) {
          partNotesList.push(`Débito restante: R$ ${(parsedDebtCents / 100).toFixed(2).replace('.', ',')}`);
        }
        if (i === 0 && parsedExcessCreditCents > 0) {
          partNotesList.push(`Crédito gerado: R$ ${(parsedExcessCreditCents / 100).toFixed(2).replace('.', ',')}`);
        }
        const partNotes = partNotesList.filter(Boolean).join(' · ') || null;

        const payment = this.store.run(
          `INSERT INTO payments (member_id, plan_id, amount_cents, method, status, external_id, notes)
           VALUES (?, ?, ?, ?, 'paid', ?, ?)`,
          [member.id, plan?.id || null, part.amount_cents, part.method, i === 0 ? external_id : null, partNotes],
        );
        const pid = payment.lastInsertRowid;
        insertedPaymentIds.push(pid);
        if (primaryPaymentId == null) primaryPaymentId = pid;

        if (openCash && part.amount_cents > 0) {
          this.store.run(
            'INSERT INTO cash_movements (session_id, type, amount_cents, method, description) VALUES (?, ?, ?, ?, ?)',
            [openCash.id, 'payment', part.amount_cents, part.method, `Mensalidade: ${member.name}${plan ? ` (${plan.name})` : ''}`],
          );
        }
      }

      if (creditUsedCents > 0 || parsedExcessCreditCents > 0) {
        let runningCredit = availableCredit;
        if (creditUsedCents > 0) {
          runningCredit = Math.max(0, runningCredit - creditUsedCents);
          this.store.run(
            `INSERT INTO member_credit_logs (member_id, delta_cents, balance_after_cents, reason, payment_id)
             VALUES (?, ?, ?, ?, ?)`,
            [member.id, -creditUsedCents, runningCredit, `Abatido no pagamento (${plan.name})`, primaryPaymentId],
          );
        }
        if (parsedExcessCreditCents > 0) {
          runningCredit += parsedExcessCreditCents;
          this.store.run(
            `INSERT INTO member_credit_logs (member_id, delta_cents, balance_after_cents, reason, payment_id)
             VALUES (?, ?, ?, ?, ?)`,
            [member.id, parsedExcessCreditCents, runningCredit, `Excedente em crédito (${plan.name})`, primaryPaymentId],
          );
        }
        this.store.run(
          "UPDATE members SET credit_cents = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
          [runningCredit, member.id],
        );
      }

      let createdDebtId = null;
      if (parsedDebtCents > 0) {
        const debtNoteFinal = String(debt_notes || notes || `Saldo pendente (${plan.name})`).trim();
        const debtRes = this.store.run(
          `INSERT INTO member_debts (member_id, origin_payment_id, plan_id, amount_cents, status, due_date, notes)
           VALUES (?, ?, ?, ?, 'open', ?, ?)`,
          [member.id, primaryPaymentId, plan.id, parsedDebtCents, dueDateNorm, debtNoteFinal],
        );
        createdDebtId = debtRes.lastInsertRowid;
      }

      if (charge && primaryPaymentId != null) {
        this.store.run('UPDATE membership_charges SET payment_id = ? WHERE id = ?', [primaryPaymentId, charge.id]);
      }
      const overdue = charge && this.store.get(
        'SELECT id FROM membership_charges WHERE member_id = ? AND payment_id IS NULL AND due < ? LIMIT 1', [member.id, today],
      );
      this.store.run(
        `UPDATE members SET status = ?, manual_access = 0, plan_id = COALESCE(?, plan_id), valid_until = ?,
         updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [overdue ? 'blocked' : 'active', plan.id, overdue ? member.valid_until : newValidUntil, member.id],
      );
      if (!overdue) {
        const startsOn = extendsCurrent ? (enrollment?.starts_on || today) : today;
        this.store.run(
          `INSERT INTO plan_enrollments (member_id, plan_id, starts_on, ends_on)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(member_id) DO UPDATE SET plan_id = excluded.plan_id, starts_on = excluded.starts_on, ends_on = excluded.ends_on`,
          [member.id, plan.id, startsOn, newValidUntil],
        );
      }
      for (const pid of insertedPaymentIds) {
        this.store.run('UPDATE payments SET enrollment_ends_on = ? WHERE id = ?', [overdue ? null : newValidUntil, pid]);
      }
      const commCents = Math.round(Number(commission_cents || 0));
      if (staff_id && primaryPaymentId != null && Number.isSafeInteger(commCents) && commCents > 0) {
        const staff = this.store.get('SELECT id, name FROM staff WHERE id = ?', [Number(staff_id)]);
        if (staff) {
          this.store.run(
            `INSERT INTO commissions (staff_id, staff_name, source_type, source_id, description, amount_cents)
             VALUES (?, ?, 'payment', ?, ?, ?)`,
            [staff.id, staff.name, primaryPaymentId, `Mensalidade: ${member.name} (${plan.name})`, commCents],
          );
        }
      }
      if (onRecorded && primaryPaymentId != null) onRecorded(primaryPaymentId);
      return { insertedPaymentIds, createdDebtId };
    });

    const updatedMember = this.getMember(member.id);
    const sync = await this.trySyncMemberToDevice(updatedMember);
    const payments = txResult.insertedPaymentIds.map((pid) => this.store.get('SELECT * FROM payments WHERE id = ?', [pid]));
    const debt = txResult.createdDebtId ? this.store.get('SELECT * FROM member_debts WHERE id = ?', [txResult.createdDebtId]) : null;

    return {
      payment: payments[0] || null,
      payments,
      debt,
      member: this.getMember(member.id),
      sync,
      credit_used_cents: creditUsedCents,
    };
  }

  listMemberDebts(memberId = null, { status = 'open' } = {}) {
    const clauses = [];
    const params = [];
    if (memberId != null) {
      clauses.push('d.member_id = ?');
      params.push(Number(memberId));
    }
    if (status && status !== 'all') {
      clauses.push('d.status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.store.all(
      `SELECT d.*, m.name AS member_name, m.document AS member_document, p.name AS plan_name,
              (d.amount_cents - d.paid_cents) AS remaining_cents
       FROM member_debts d
       JOIN members m ON m.id = d.member_id
       LEFT JOIN plans p ON p.id = d.plan_id
       ${where}
       ORDER BY CASE WHEN d.status = 'open' THEN 0 ELSE 1 END, COALESCE(d.due_date, '9999-12-31') ASC, d.id DESC`,
      params,
    );
  }

  payMemberDebt(debtId, { amount_cents = null, method = 'pix', split_payments = null, notes = null } = {}, { requireOpenCash = true } = {}) {
    const openCash = this.store.get("SELECT id FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    if (requireOpenCash && !openCash) {
      throw Object.assign(new Error('Caixa fechado. Abra o caixa para registrar o recebimento.'), {
        statusCode: 409, code: 'CASH_CLOSED',
      });
    }
    const debt = this.store.get('SELECT * FROM member_debts WHERE id = ?', [Number(debtId)]);
    if (!debt) throw Object.assign(new Error('Débito não encontrado.'), { statusCode: 404 });
    if (debt.status !== 'open') throw Object.assign(new Error('Este débito já foi encerrado.'), { statusCode: 409 });

    const remaining = Number(debt.amount_cents) - Number(debt.paid_cents || 0);
    const parsedSplits = this.normalizeSplitPayments(split_payments);
    const parts = parsedSplits !== null
      ? parsedSplits
      : [{ method: String(method || 'pix').trim(), amount_cents: amount_cents != null ? Math.round(Number(amount_cents)) : remaining }];

    if (!parts.length) {
      throw Object.assign(new Error('Informe ao menos um valor para receber o débito.'), { statusCode: 400 });
    }
    const totalPay = parts.reduce((acc, p) => acc + p.amount_cents, 0);
    if (!Number.isSafeInteger(totalPay) || totalPay <= 0 || totalPay > remaining) {
      throw Object.assign(new Error(`Valor deve ser maior que zero e até R$ ${(remaining / 100).toFixed(2)}.`), { statusCode: 400 });
    }

    const member = this.getMember(debt.member_id);
    const tx = this.store.transaction(() => {
      const paymentIds = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const noteStr = [
          `Quitação de débito #${debt.id}`,
          parts.length > 1 ? `Pagamento misto (${i + 1}/${parts.length})` : null,
          notes,
        ].filter(Boolean).join(' · ');
        const res = this.store.run(
          `INSERT INTO payments (member_id, plan_id, amount_cents, method, status, notes)
           VALUES (?, ?, ?, ?, 'paid', ?)`,
          [debt.member_id, debt.plan_id, part.amount_cents, part.method, noteStr],
        );
        paymentIds.push(res.lastInsertRowid);
        if (openCash) {
          this.store.run(
            'INSERT INTO cash_movements (session_id, type, amount_cents, method, description) VALUES (?, ?, ?, ?, ?)',
            [openCash.id, 'payment', part.amount_cents, part.method, `Quitação de débito: ${member?.name || `#${debt.member_id}`}`],
          );
        }
      }
      const nextPaid = Number(debt.paid_cents || 0) + totalPay;
      const fullyPaid = nextPaid >= Number(debt.amount_cents);
      this.store.run(
        `UPDATE member_debts
         SET paid_cents = ?, status = ?, paid_at = CASE WHEN ? THEN datetime('now', 'localtime') ELSE paid_at END
         WHERE id = ?`,
        [nextPaid, fullyPaid ? 'paid' : 'open', fullyPaid ? 1 : 0, debt.id],
      );
      return paymentIds;
    });

    return {
      debt: this.store.get('SELECT *, (amount_cents - paid_cents) AS remaining_cents FROM member_debts WHERE id = ?', [debt.id]),
      payments: tx.map((pid) => this.store.get('SELECT * FROM payments WHERE id = ?', [pid])),
      member: this.getMember(debt.member_id),
    };
  }

  cancelMemberDebt(debtId, { reason = null } = {}) {
    const debt = this.store.get('SELECT * FROM member_debts WHERE id = ?', [Number(debtId)]);
    if (!debt) throw Object.assign(new Error('Débito não encontrado.'), { statusCode: 404 });
    if (debt.status !== 'open') throw Object.assign(new Error('Somente débitos em aberto podem ser cancelados.'), { statusCode: 409 });
    const nextNotes = [debt.notes, reason ? `Cancelado: ${String(reason).trim()}` : 'Cancelado pela recepção'].filter(Boolean).join(' · ');
    this.store.run(
      "UPDATE member_debts SET status = 'cancelled', notes = ?, paid_at = datetime('now', 'localtime') WHERE id = ?",
      [nextNotes, debt.id],
    );
    return {
      debt: this.store.get('SELECT * FROM member_debts WHERE id = ?', [debt.id]),
      member: this.getMember(debt.member_id),
    };
  }

  listMemberCreditLogs(memberId, limit = 20) {
    return this.store.all(
      'SELECT * FROM member_credit_logs WHERE member_id = ? ORDER BY id DESC LIMIT ?',
      [Number(memberId), Number(limit)],
    );
  }

  adjustMemberCredit(memberId, { amount_cents, type = 'add', reason = '' } = {}) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    const cents = Math.round(Number(amount_cents || 0));
    if (!Number.isFinite(cents) || cents <= 0) {
      throw new Error('Informe um valor de crédito maior que zero.');
    }
    const current = Number(member.credit_cents || 0);
    const delta = type === 'remove' ? -cents : cents;
    const nextBalance = current + delta;
    if (nextBalance < 0) {
      throw new Error('Saldo de crédito insuficiente para remover esse valor.');
    }

    this.store.transaction(() => {
      this.store.run(
        "UPDATE members SET credit_cents = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [nextBalance, member.id],
      );
      this.store.run(
        `INSERT INTO member_credit_logs (member_id, delta_cents, balance_after_cents, reason)
         VALUES (?, ?, ?, ?)`,
        [member.id, delta, nextBalance, String(reason || '').trim() || (delta > 0 ? 'Crédito adicionado' : 'Crédito removido')],
      );
    });

    return {
      member: this.getMember(member.id),
      credit_cents: nextBalance,
      logs: this.listMemberCreditLogs(member.id),
    };
  }

  syncMembershipCharges(refToday = null) {
    const today = refToday || this.store.get("SELECT date('now', 'localtime') AS today").today;
    const expireBefore = addDays(today, -2);
    const generateUntil = addDays(today, 10);

    const expiredResult = this.store.run(
      "DELETE FROM membership_charges WHERE payment_id IS NULL AND COALESCE(source, 'auto') = 'auto' AND due < ?",
      [expireBefore],
    );

    const candidates = this.store.all(
      `SELECT m.id AS member_id, COALESCE(e.ends_on, m.valid_until) AS due, p.price_cents AS amount
       FROM members m
       JOIN plan_enrollments e ON e.member_id = m.id
       JOIN plans p ON p.id = e.plan_id
       WHERE m.access_role = 'student'
         AND m.partner_provider IS NULL
         AND m.status IN ('active', 'blocked')
         AND p.duration_days > 1
         AND p.price_cents > 0
         AND COALESCE(e.ends_on, m.valid_until) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM membership_charges c
           WHERE c.member_id = m.id AND (c.due = COALESCE(e.ends_on, m.valid_until) OR c.payment_id IS NULL)
         )`,
      [expireBefore, generateUntil],
    );

    let generated = 0;
    if (candidates.length) {
      this.store.transaction(() => {
        for (const row of candidates) {
          this.store.run(
            'INSERT OR IGNORE INTO membership_charges (member_id, due, amount) VALUES (?, ?, ?)',
            [row.member_id, row.due, row.amount],
          );
          generated += 1;
        }
      });
    }

    return {
      today,
      deleted: expiredResult?.changes || 0,
      generated,
    };
  }

  async checkExpiredMembers() {
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    this.syncMembershipCharges(today);
    const cutoff = this.enrollmentCutoff(today);
    const overdue = this.store.all(
      `SELECT m.id, m.name, m.document, m.controlid_user_id, m.access_role, m.partner_provider, m.wellhub_id, m.status
       FROM members m LEFT JOIN plan_enrollments e ON e.member_id = m.id
       LEFT JOIN plans p ON p.id = e.plan_id
       WHERE m.access_role = 'student' AND m.status = 'active'
         AND (m.partner_provider IS NULL OR m.partner_provider NOT IN ('wellhub', 'totalpass'))
         AND (p.id IS NULL OR e.ends_on IS NULL OR e.ends_on < ?)`,
      [cutoff],
    );
    const shouldBeActive = this.store.all(
      `SELECT m.id, m.name, m.document, m.controlid_user_id, m.access_role, m.partner_provider, m.wellhub_id, m.status
       FROM members m JOIN plan_enrollments e ON e.member_id = m.id
       JOIN plans p ON p.id = e.plan_id
       WHERE m.access_role = 'student' AND m.status <> 'active'
         AND COALESCE(m.manual_access, 0) = 0
         AND e.ends_on >= ?`,
      [cutoff],
    );
    if (!overdue.length && !shouldBeActive.length) return [];

    if (shouldBeActive.length) {
      this.store.transaction(() => {
        for (const member of shouldBeActive) {
          this.store.run(
            "UPDATE members SET status = 'active', updated_at = datetime('now', 'localtime') WHERE id = ?",
            [member.id],
          );
        }
      });
      for (const member of shouldBeActive) {
        await this.trySyncMemberToDevice({ ...member, status: 'active' }).catch(() => {});
      }
    }
    if (!overdue.length) return [];

    this.store.transaction(() => {
      for (const member of overdue) {
        this.store.run(
          "UPDATE members SET status = 'blocked', manual_access = 0, updated_at = datetime('now', 'localtime') WHERE id = ?",
          [member.id],
        );
      }
    });

    const syncUpdates = [];
    const results = [];
    const secondaryClients = this._getSecondaryControlIdClients();
    for (const member of overdue) {
      const blockedMember = { ...member, status: 'blocked' };
      try {
        const deviceId = blockedMember.controlid_user_id || blockedMember.id;
        if (this.store.get('SELECT id FROM members WHERE controlid_user_id = ? AND id <> ?', [deviceId, blockedMember.id])) {
          throw new Error('ID facial vinculado a outro cadastro. Confira o vínculo no perfil.');
        }
        const result = await this.controlId.syncMember(blockedMember, false);
        const syncedDeviceId = result?.controlIdUserId ?? deviceId;
        for (const { client } of secondaryClients) {
          try {
            await client.syncMember({ ...blockedMember, controlid_user_id: syncedDeviceId }, false);
          } catch {
            // Leitores secundários sincronizados em regime best-effort
          }
        }
        syncUpdates.push({ id: blockedMember.id, deviceId: syncedDeviceId, error: null });
        results.push({ id: blockedMember.id, name: blockedMember.name, synced: true });
      } catch (err) {
        syncUpdates.push({ id: blockedMember.id, deviceId: null, error: err.message });
        results.push({ id: blockedMember.id, name: blockedMember.name, synced: false });
      }
    }

    this.store.transaction(() => {
      for (const upd of syncUpdates) {
        if (upd.error) {
          this.store.run(
            "UPDATE members SET last_sync_error = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
            [upd.error, upd.id],
          );
        } else {
          this.store.run(
            "UPDATE members SET controlid_user_id = COALESCE(controlid_user_id, ?), last_sync_error = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?",
            [upd.deviceId, upd.id],
          );
        }
      }
    });

    return results;
  }

  /**
   * Remove da(s) turma(s) alunos cujo vencimento passou há mais de `graceDays` dias (padrão: 5 dias de tolerância).
   * Retorna os alunos afetados junto com as turmas liberadas para notificação.
   */
  removeOverdueClassEnrollments(graceDays = 5, now = new Date()) {
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const cutoffIso = addDays(todayIso, -Math.max(0, Number(graceDays ?? 5)));

    const candidates = this.store.all(
      `SELECT DISTINCT m.id, m.name, m.phone, COALESCE(e.ends_on, m.valid_until) AS valid_until
       FROM members m
       JOIN class_enrollments ce ON ce.member_id = m.id
       LEFT JOIN plan_enrollments e ON e.member_id = m.id
       WHERE m.access_role = 'student'
         AND COALESCE(m.manual_access, 0) = 0
         AND COALESCE(e.ends_on, m.valid_until) IS NOT NULL
         AND COALESCE(e.ends_on, m.valid_until) < ?`,
      [cutoffIso],
    );

    if (!candidates.length) return [];

    return this.store.transaction(() => {
      const removed = [];
      for (const member of candidates) {
        const classes = this.store.all(
          `SELECT c.id, c.name, c.schedule
           FROM class_enrollments ce
           JOIN classes c ON c.id = ce.class_id
           WHERE ce.member_id = ?
           ORDER BY c.name ASC`,
          [member.id],
        );
        if (!classes.length) continue;
        this.store.run('DELETE FROM class_enrollments WHERE member_id = ?', [member.id]);
        removed.push({
          id: member.id,
          name: member.name,
          phone: member.phone,
          valid_until: member.valid_until,
          removedClasses: classes,
        });
      }
      return removed;
    });
  }

  async syncAccessLogs() {
    const logs = await this.controlId.fetchAccessLogs(50);
    const toLocalDateTime = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

    const inserted = this.store.transaction(() => {
      if (!logs.length) return 0;
      const logIds = [...new Set(logs.map((l) => l.id).filter((id) => id != null))];
      const existingIds = new Set(
        logIds.length
          ? this.store.all(`SELECT controlid_log_id FROM access_logs WHERE controlid_log_id IN (${logIds.map(() => '?').join(',')})`, logIds).map((r) => r.controlid_log_id)
          : [],
      );
      const userIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))];
      const memberByDeviceId = new Map(
        userIds.length
          ? this.store.all(`SELECT id, name, controlid_user_id FROM members WHERE controlid_user_id IN (${userIds.map(() => '?').join(',')})`, userIds).map((m) => [m.controlid_user_id, m])
          : [],
      );

      let count = 0;
      for (const log of logs) {
        if (existingIds.has(log.id)) continue;
        existingIds.add(log.id);

        const member = log.user_id ? memberByDeviceId.get(log.user_id) || null : null;

        const occurredAt = log.time
          ? toLocalDateTime(new Date(Number(log.time) * 1000))
          : toLocalDateTime(new Date());

        this.store.run(
          `INSERT INTO access_logs (controlid_log_id, controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            log.id,
            log.user_id || null,
            member?.id || null,
            member?.name || (log.user_id ? `ID ${log.user_id}` : 'Desconhecido'),
            log.event ?? null,
            EVENT_LABELS[log.event] || `Evento ${log.event ?? '-'}`,
            occurredAt,
          ],
        );
        count += 1;
      }
      return count;
    });

    return {
      inserted,
      logs: this.store.all('SELECT * FROM access_logs ORDER BY id DESC LIMIT 50'),
    };
  }

  async releaseTurnstile(direction = null, message = 'LIBERADO', { turnstileId = null } = {}) {
    const settings = this.store.getSettings();
    const devices = new DeviceService(this.store, this.controlId, this.toletus);
    const turnstile = turnstileId ? devices.getTurnstile(turnstileId) : devices.getPrimaryTurnstile();
    const effectiveDir = direction || turnstile?.default_direction || settings.turnstile_direction || 'entry';
    const dirLabel = effectiveDir === 'exit' ? 'Saída' : effectiveDir === 'both' ? 'Entrada/Saída' : 'Entrada';
    const useToletus = this.toletus && (turnstile ? (turnstile.driver === 'toletus' && Boolean(turnstile.active)) : settings.toletus_enabled !== 'false');

    if (useToletus) {
      const override = turnstile ? { ip: turnstile.ip, port: turnstile.port, enabled: true } : null;
      const res = await this.toletus.releaseDirection(effectiveDir, message, override);

      this.store.run(
        `INSERT INTO access_logs (member_name, event_code, event_label, occurred_at)
         VALUES (?, ?, ?, datetime('now', 'localtime'))`,
        ['Recepção', 12, `Liberação manual Toletus (${turnstile?.name || 'Principal'} · ${dirLabel})`],
      );
      this.publishTurnstileDisplay('allowed', { source: `Liberação manual (${dirLabel})` });
      return { driver: 'toletus', turnstile_id: turnstile?.id || null, direction: effectiveDir, ...res };
    }

    const linkedReader = turnstile
      ? this.store.get('SELECT * FROM readers WHERE turnstile_id = ? AND active = 1 ORDER BY id ASC LIMIT 1', [turnstile.id])
      : null;
    const res = await this.controlId.releaseTurnstile(linkedReader);
    this.store.run(
      `INSERT INTO access_logs (member_name, event_code, event_label, occurred_at)
       VALUES (?, ?, ?, datetime('now', 'localtime'))`,
      ['Recepção', 12, `Liberação manual Control iD (${turnstile?.name || 'Principal'} · ${dirLabel})`],
    );
    this.publishTurnstileDisplay('allowed', { source: `Liberação manual (${dirLabel})` });
    return { driver: 'controlid', turnstile_id: turnstile?.id || null, direction: effectiveDir, ...res };
  }

  /**
   * Chamado pelo Control iD no Modo Online quando uma face e reconhecida.
   * Valida a mensalidade e libera a catraca Toletus automaticamente.
   */
  async handleFaceIdentified(controlIdUserId, context = {}) {
    const userId = Number(controlIdUserId);
    const lockKey = Number.isSafeInteger(userId) && userId > 0 ? userId : null;
    if (lockKey && this._faceInFlight.has(lockKey)) {
      return this._faceInFlight.get(lockKey);
    }
    const run = this._handleFaceIdentifiedOnce(controlIdUserId, context);
    if (!lockKey) return run;
    this._faceInFlight.set(lockKey, run);
    try {
      return await run;
    } finally {
      this._faceInFlight.delete(lockKey);
    }
  }

  async _handleFaceIdentifiedOnce(controlIdUserId, context = {}) {
    const userId = Number(controlIdUserId);
    const linked = Number.isSafeInteger(userId) && userId > 0
      ? this.store.all('SELECT * FROM members WHERE controlid_user_id = ? LIMIT 2', [userId]) : [];
    const member = linked.length === 1 ? linked[0] : null;

    if (!member) {
      this.store.run(
        `INSERT INTO access_logs (controlid_user_id, member_name, event_code, event_label, occurred_at)
         VALUES (?, ?, 3, 'Não identificado', datetime('now', 'localtime'))`,
        [Number(controlIdUserId) || null, 'Desconhecido'],
      );
      this.publishTurnstileDisplay('unrecognized');
      return { allowed: false, event: 6, message: 'Aluno nao cadastrado' };
    }

    const settings = this.store.getSettings();
    if (!this.controlId.getConfig?.().mockMode && this.controlId.getDeviceUser) {
      const now = Date.now();
      const cached = this._verifiedDeviceUsers.get(userId);
      const cacheMatchesMember = Boolean(
        cached &&
        cached.memberId === member.id &&
        cached.name === member.name &&
        cached.document === member.document,
      );
      let verified = Boolean(cacheMatchesMember && cached.expiresAt > now);
      if (!verified) {
        try {
          const user = await this.controlId.getDeviceUser(userId);
          verified = Boolean(user && matchesDeviceIdentity(member, user));
          if (verified) {
            this._verifiedDeviceUsers.set(userId, {
              memberId: member.id,
              name: member.name,
              document: member.document,
              expiresAt: now + 5 * 60 * 1000,
            });
          } else {
            this._verifiedDeviceUsers.delete(userId);
          }
        } catch {
          // Se o vínculo já havia sido validado para este exato membro/CPF e o leitor apenas oscilou na rede, preserva a confirmação
          if (cacheMatchesMember) {
            verified = true;
          }
        }
      }
      const current = this.store.all('SELECT id, name, document FROM members WHERE controlid_user_id = ? LIMIT 2', [userId]);
      if (!verified || current.length !== 1 || current[0].id !== member.id ||
          current[0].name !== member.name || current[0].document !== member.document) {
        this._verifiedDeviceUsers.delete(userId);
        this.store.run(`INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
          VALUES (?, ?, ?, 6, 'Acesso negado (vínculo facial não confirmado)', datetime('now', 'localtime'))`, [userId, member.id, member.name]);
        this.publishTurnstileDisplay('denied', { reason: 'Vínculo facial não confirmado' });
        return { allowed: false, event: 6, message: 'Vínculo facial não confirmado' };
      }
    }
    const currentMember = this.getMember(member.id);
    let reason = this.getAccessDenial(currentMember);
    if (reason && /^Check-in (Wellhub|TotalPass) pendente hoje$/.test(reason)) {
      const hasExternalCreds = currentMember.partner_provider === 'wellhub'
        ? Boolean(settings.wellhub_api_key && settings.wellhub_gym_id)
        : Boolean(settings.totalpass_api_token && settings.totalpass_gym_id);
      if (hasExternalCreds) {
        try {
          await new PartnerService(this.store).registerMemberCheckin({ memberId: currentMember.id, source: 'turnstile' });
          reason = this.getAccessDenial(currentMember);
        } catch (err) {
          reason = err.message;
        }
      }
    }
    if (reason) {
      this.store.run(
        `INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
         VALUES (?, ?, ?, 6, ?, datetime('now', 'localtime'))`,
        [member.controlid_user_id, member.id, member.name, `Acesso negado (${reason})`],
      );
      this.publishTurnstileDisplay('denied', { reason, member: currentMember });
      return { allowed: false, event: 6, message: reason, member };
    }

    const devices = new DeviceService(this.store, this.controlId, this.toletus);
    const reader = devices.findReaderByRequest({ readerId: context.readerId, readerIp: context.readerIp });
    const turnstile = reader?.turnstile_id ? devices.getTurnstile(reader.turnstile_id) : devices.getPrimaryTurnstile();
    const direction = reader?.direction || turnstile?.default_direction || settings.turnstile_direction || 'entry';

    const antipassbackMinutes = Math.max(0, Math.floor(Number(settings.antipassback_minutes || 0)));
    if (antipassbackMinutes > 0 && currentMember.access_role === 'student') {
      const recentPass = this.store.get(
        `SELECT id FROM access_logs
         WHERE member_id = ? AND event_code = 7 AND occurred_at >= datetime('now', 'localtime', ?)
         ORDER BY id DESC LIMIT 1`,
        [member.id, `-${antipassbackMinutes} minutes`],
      );
      if (recentPass) {
        const apReason = `Aguarde ${antipassbackMinutes} min (antipassback)`;
        this.store.run(
          `INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
           VALUES (?, ?, ?, 6, ?, datetime('now', 'localtime'))`,
          [member.controlid_user_id, member.id, member.name, `Acesso negado (${apReason})`],
        );
        this.publishTurnstileDisplay('denied', { reason: apReason, member: currentMember });
        return { allowed: false, event: 6, message: apReason, member };
      }
    }

    const maxCapacity = Math.max(0, Math.floor(Number(settings.max_capacity || 0)));
    const useToletus = this.toletus && (turnstile ? (turnstile.driver === 'toletus' && Boolean(turnstile.active)) : settings.toletus_enabled !== 'false');

    const executeEntry = async () => {
      if (maxCapacity > 0 && direction !== 'exit' && currentMember.access_role === 'student') {
        const occ = this.getCurrentOccupancy();
        const alreadyInside = occ.members.some((m) => m.id === member.id);
        if (!alreadyInside && occ.count >= maxCapacity) {
          const capReason = 'Lotação máxima atingida';
          this.store.run(
            `INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
             VALUES (?, ?, ?, 6, ?, datetime('now', 'localtime'))`,
            [member.controlid_user_id, member.id, member.name, `Acesso negado (${capReason})`],
          );
          this.publishTurnstileDisplay('denied', { reason: capReason, member: currentMember });
          return { allowed: false, event: 6, message: capReason, member };
        }
      }

      if (useToletus) {
        try {
          const override = turnstile ? { ip: turnstile.ip, port: turnstile.port, enabled: true } : null;
          await this.toletus.releaseDirection(direction, member.name.split(' ')[0] || 'BEM VINDO', override);
        } catch (err) {
          this.store.run(
            `INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
             VALUES (?, ?, ?, 6, ?, datetime('now', 'localtime'))`,
            [member.controlid_user_id, member.id, member.name, `Falha ao acionar Toletus: ${err.message}`],
          );
          this.publishTurnstileDisplay('error');
          throw err;
        }
      }

      const date = fitnessToday();
      const visits = currentMember.access_role === 'student' ? weeklyVisits(this.store, member.id, date) : null;
      const progress = visits && !visits.includes(date) ? { visits: visits.length + 1, goal: weeklyGoal(this.store, member.id) } : null;
      this.store.run(
        `INSERT INTO access_logs (controlid_user_id, member_id, member_name, event_code, event_label, occurred_at)
         VALUES (?, ?, ?, 7, 'Acesso autorizado (FaceID)', datetime('now', 'localtime'))`,
        [member.controlid_user_id, member.id, member.name],
      );

      this.publishTurnstileDisplay('allowed', { member: currentMember, progress, source: 'FaceID' });
      return { allowed: true, event: 7, message: 'Bem vindo', member: currentMember };
    };

    if (maxCapacity > 0 && direction !== 'exit' && currentMember.access_role === 'student') {
      return this._withCapacityLock(executeEntry);
    }
    return executeEntry();
  }

  async recordCancellation({ member_id, reason, notes = null }) {
    const member = this.getMember(member_id);
    if (!member) throw new Error('Aluno não encontrado.');
    if (member.access_role !== 'student') throw new Error('Cancelamento exige um cadastro de aluno.');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new Error('Informe o motivo do cancelamento.');

    const res = this.store.transaction(() => {
      this.store.run("UPDATE members SET status = 'blocked', manual_access = 0 WHERE id = ?", [member.id]);
      return this.store.run(
        'INSERT INTO enrollment_cancellations (member_id, plan_id, reason, notes) VALUES (?, ?, ?, ?)',
        [member.id, member.plan_id || null, cleanReason, notes ? String(notes).trim() : null],
      );
    });
    if (member.status !== 'blocked') await this.trySyncMemberToDevice(this.getMember(member.id));

    return this.store.get(
      `SELECT ec.*, m.name AS member_name, p.name AS plan_name
       FROM enrollment_cancellations ec
       JOIN members m ON m.id = ec.member_id
       LEFT JOIN plans p ON p.id = ec.plan_id
       WHERE ec.id = ?`,
      [res.lastInsertRowid],
    );
  }

  getChurnRiskMembers({ limit = 25, refToday = null } = {}) {
    const today = refToday || this.store.get("SELECT date('now', 'localtime') AS today").today;
    const recentStart = addDays(today, -13);
    const prevStart = addDays(today, -27);
    const prevEnd = addDays(today, -14);
    const nextDay = addDays(today, 1);

    const rows = this.store.all(
      `SELECT m.id, m.name, m.phone, m.valid_until, p.name AS plan_name,
              COUNT(DISTINCT CASE WHEN substr(l.occurred_at, 1, 10) BETWEEN ? AND ? THEN substr(l.occurred_at, 1, 10) END) AS recent_visits,
              COUNT(DISTINCT CASE WHEN substr(l.occurred_at, 1, 10) BETWEEN ? AND ? THEN substr(l.occurred_at, 1, 10) END) AS prev_visits,
              MAX(substr(l.occurred_at, 1, 10)) AS last_visit
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN access_logs l ON l.member_id = m.id
         AND l.event_code = 7
         AND l.event_label = 'Acesso autorizado (FaceID)'
         AND l.occurred_at < ?
       WHERE m.access_role = 'student'
         AND m.status = 'active'
         AND (m.frozen_until IS NULL OR m.frozen_until < ?)
       GROUP BY m.id
       HAVING (prev_visits >= 3 AND recent_visits <= 1)
           OR (last_visit IS NOT NULL AND last_visit <= ? AND recent_visits = 0)
       ORDER BY recent_visits ASC, prev_visits DESC, last_visit ASC
       LIMIT ?`,
      [recentStart, today, prevStart, prevEnd, nextDay, today, addDays(today, -10), Number(limit)],
    );

    return rows.map((r) => {
      const daysAbsent = r.last_visit
        ? Math.max(0, Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${r.last_visit}T12:00:00Z`)) / 86400000))
        : null;
      const riskLevel = (Number(r.prev_visits) >= 4 && Number(r.recent_visits) === 0) || (daysAbsent !== null && daysAbsent >= 14)
        ? 'high'
        : 'medium';
      return {
        ...r,
        days_absent: daysAbsent,
        risk_level: riskLevel,
      };
    });
  }

  getAnalyticsReport(requestedMonth = null) {
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const month = /^\d{4}-\d{2}$/.test(String(requestedMonth || '')) ? String(requestedMonth) : today.slice(0, 7);

    const [yr, mo] = month.split('-').map(Number);
    const shiftMonth = (baseYear, baseMonth, delta) => {
      const d = new Date(Date.UTC(baseYear, baseMonth - 1 + delta, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    const prevMonth = shiftMonth(yr, mo, -1);

    const mensalidadesRow = this.store.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count
       FROM payments WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?`,
      [month],
    );
    const vendasRow = this.store.get(
      `SELECT COALESCE(SUM(total_cents), 0) AS total, COUNT(*) AS count
       FROM sales WHERE substr(sold_at, 1, 7) = ?`,
      [month],
    );
    const prevMens = this.store.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?`,
      [prevMonth],
    )?.total ?? 0;
    const prevSales = this.store.get(
      `SELECT COALESCE(SUM(total_cents), 0) AS total FROM sales WHERE substr(sold_at, 1, 7) = ?`,
      [prevMonth],
    )?.total ?? 0;

    const mensalidadesCents = Number(mensalidadesRow?.total || 0);
    const vendasCents = Number(vendasRow?.total || 0);
    const totalCents = mensalidadesCents + vendasCents;
    const prevTotalCents = Number(prevMens) + Number(prevSales);
    const paymentsCount = Number(mensalidadesRow?.count || 0);
    const ticketAvgCents = paymentsCount > 0 ? Math.round(mensalidadesCents / paymentsCount) : 0;
    const growthPct = prevTotalCents > 0 ? Number((((totalCents - prevTotalCents) / prevTotalCents) * 100).toFixed(1)) : null;

    const byMethod = this.store.all(
      `SELECT COALESCE(pm.name, p.method) AS label, p.method AS code,
              COALESCE(SUM(p.amount_cents), 0) AS total_cents, COUNT(*) AS count
       FROM payments p
       LEFT JOIN payment_methods pm ON pm.code = p.method
       WHERE p.status = 'paid' AND substr(p.paid_at, 1, 7) = ?
       GROUP BY p.method
       ORDER BY total_cents DESC`,
      [month],
    );

    const byPlan = this.store.all(
      `SELECT COALESCE(pl.name, 'Sem plano') AS name,
              COALESCE(SUM(p.amount_cents), 0) AS total_cents, COUNT(*) AS count
       FROM payments p
       LEFT JOIN plans pl ON pl.id = p.plan_id
       WHERE p.status = 'paid' AND substr(p.paid_at, 1, 7) = ?
       GROUP BY p.plan_id
       ORDER BY total_cents DESC`,
      [month],
    );

    // Projeções financeiras (MRR estimado dos ativos + a receber no mês + série 6m realizados + 3m projetados)
    const mrrRow = this.store.get(
      `SELECT COALESCE(SUM(ROUND(pl.price_cents * 30.0 / CASE WHEN pl.duration_days > 0 THEN pl.duration_days ELSE 30 END)), 0) AS mrr
       FROM members m
       JOIN plan_enrollments e ON e.member_id = m.id
       JOIN plans pl ON pl.id = e.plan_id
       WHERE m.access_role = 'student' AND m.status = 'active' AND (e.ends_on IS NULL OR e.ends_on >= ?)`,
      [today],
    );
    const mrrCents = Number(mrrRow?.mrr || 0);

    const openChargesCents = Number(
      this.store.get(
        `SELECT COALESCE(SUM(c.amount), 0) AS total
         FROM membership_charges c
         JOIN members m ON m.id = c.member_id
         WHERE m.access_role = 'student' AND c.payment_id IS NULL AND substr(c.due, 1, 7) = ?`,
        [month],
      )?.total || 0,
    );
    const upcomingRenewalsCents = Number(
      this.store.get(
        `SELECT COALESCE(SUM(pl.price_cents), 0) AS total
         FROM members m
         JOIN plan_enrollments e ON e.member_id = m.id
         JOIN plans pl ON pl.id = e.plan_id
         WHERE m.access_role = 'student' AND m.status = 'active'
           AND e.ends_on >= ? AND substr(e.ends_on, 1, 7) = ?
           AND NOT EXISTS (
             SELECT 1 FROM membership_charges c
             WHERE c.member_id = m.id
               AND c.payment_id IS NULL
               AND substr(c.due, 1, 7) = ?
           )`,
        [today, month, month],
      )?.total || 0,
    );
    const openReceivablesCents = openChargesCents + upcomingRenewalsCents;
    const projectedMonthEndCents = totalCents + openReceivablesCents;

    const series = [];
    const minSeriesMonth = shiftMonth(yr, mo, -5);
    const payByMonth = new Map(
      this.store.all(
        `SELECT substr(paid_at, 1, 7) AS m, COALESCE(SUM(amount_cents), 0) AS t
         FROM payments
         WHERE status = 'paid' AND substr(paid_at, 1, 7) BETWEEN ? AND ?
         GROUP BY 1`,
        [minSeriesMonth, month],
      ).map((r) => [r.m, Number(r.t || 0)]),
    );
    const salesByMonth = new Map(
      this.store.all(
        `SELECT substr(sold_at, 1, 7) AS m, COALESCE(SUM(total_cents), 0) AS t
         FROM sales
         WHERE substr(sold_at, 1, 7) BETWEEN ? AND ?
         GROUP BY 1`,
        [minSeriesMonth, month],
      ).map((r) => [r.m, Number(r.t || 0)]),
    );
    let recentRealizedSum = 0;
    let recentNonZeroCount = 0;
    for (let i = -5; i <= 0; i++) {
      const mKey = shiftMonth(yr, mo, i);
      const pTot = payByMonth.get(mKey) || 0;
      const sTot = salesByMonth.get(mKey) || 0;
      const tot = pTot + sTot;
      if (tot > 0) {
        recentRealizedSum += tot;
        recentNonZeroCount += 1;
      }
      series.push({ month: mKey, mensalidadesCents: pTot, vendasCents: sTot, totalCents: tot, projected: false });
    }
    const avgRealized = recentNonZeroCount > 0 ? Math.round(recentRealizedSum / recentNonZeroCount) : 0;
    const baseForecast = mrrCents > 0 && avgRealized > 0 ? Math.round(mrrCents * 0.65 + avgRealized * 0.35) : mrrCents || avgRealized;
    for (let i = 1; i <= 3; i++) {
      const mKey = shiftMonth(yr, mo, i);
      series.push({ month: mKey, mensalidadesCents: baseForecast, vendasCents: 0, totalCents: baseForecast, projected: true });
    }

    // Resumo de alunos
    const studentCounts = new Map(
      this.store
        .all(
          `SELECT CASE
             WHEN m.partner_provider IN ('wellhub', 'totalpass') THEN CASE WHEN m.status = 'blocked' THEN 'blocked' ELSE 'active' END
             WHEN m.status = 'blocked' OR e.ends_on < ? THEN 'blocked'
             WHEN p.id IS NULL OR e.ends_on IS NULL THEN 'pending'
             ELSE m.status
           END AS st, COUNT(*) AS c
           FROM members m
           LEFT JOIN plan_enrollments e ON e.member_id = m.id
           LEFT JOIN plans p ON p.id = e.plan_id
           WHERE m.access_role = 'student'
           GROUP BY 1`,
          [this.enrollmentCutoff(today)],
        )
        .map((r) => [r.st, Number(r.c)]),
    );
    const activeStudents = studentCounts.get('active') || 0;
    const blockedStudents = studentCounts.get('blocked') || 0;
    const pendingStudents = studentCounts.get('pending') || 0;

    const newInMonth = Number(
      this.store.get(
        `SELECT COUNT(*) AS c FROM members WHERE access_role = 'student' AND substr(created_at, 1, 7) = ?`,
        [month],
      )?.c || 0,
    );
    const renewedInMonth = Number(
      this.store.get(
        `SELECT COUNT(DISTINCT p.member_id) AS c
         FROM payments p JOIN members m ON m.id = p.member_id
         WHERE m.access_role = 'student' AND p.status = 'paid' AND substr(p.paid_at, 1, 7) = ?`,
        [month],
      )?.c || 0,
    );
    const canceledInMonth = Number(
      this.store.get(
        `SELECT COUNT(*) AS c FROM enrollment_cancellations WHERE substr(canceled_at, 1, 7) = ?`,
        [month],
      )?.c || 0,
    );
    const churnBase = activeStudents + canceledInMonth;
    const churnRatePct = churnBase > 0 ? Number(((canceledInMonth / churnBase) * 100).toFixed(1)) : 0;

    const byModality = this.store.all(
      `SELECT COALESCE(mod.name, 'Sem modalidade') AS name, COUNT(*) AS count
       FROM members m
       LEFT JOIN modalities mod ON mod.id = m.modality_id
       WHERE m.access_role = 'student' AND m.status = 'active'
       GROUP BY m.modality_id
       ORDER BY count DESC`,
    );

    // Motivos de cancelamento
    const cancellationsByReason = this.store.all(
      `SELECT reason, COUNT(*) AS count
       FROM enrollment_cancellations
       GROUP BY reason
       ORDER BY count DESC`,
    );
    const recentCancellations = this.store.all(
      `SELECT ec.*, m.name AS member_name, p.name AS plan_name
       FROM enrollment_cancellations ec
       JOIN members m ON m.id = ec.member_id
       LEFT JOIN plans p ON p.id = ec.plan_id
       ORDER BY ec.id DESC
       LIMIT 20`,
    );
    const totalCancellations = cancellationsByReason.reduce((acc, r) => acc + Number(r.count || 0), 0);

    // Tempo de permanência média mensal (em meses)
    const retentionRow = this.store.get(
      `SELECT
         AVG(CASE
           WHEN julianday(COALESCE(ec_max.last_cancel, e.ends_on, date('now', 'localtime'))) >= julianday(COALESCE(p_min.first_paid, m.created_at))
           THEN (julianday(COALESCE(ec_max.last_cancel, e.ends_on, date('now', 'localtime'))) - julianday(COALESCE(p_min.first_paid, m.created_at))) / 30.0
           ELSE 0
         END) AS avg_overall,
         AVG(CASE
           WHEN m.status = 'active' AND julianday(COALESCE(e.ends_on, date('now', 'localtime'))) >= julianday(COALESCE(p_min.first_paid, m.created_at))
           THEN (julianday(COALESCE(e.ends_on, date('now', 'localtime'))) - julianday(COALESCE(p_min.first_paid, m.created_at))) / 30.0
           ELSE NULL
         END) AS avg_active,
         AVG(CASE
           WHEN (m.status = 'blocked' OR ec_max.last_cancel IS NOT NULL)
                AND julianday(COALESCE(ec_max.last_cancel, e.ends_on, date('now', 'localtime'))) >= julianday(COALESCE(p_min.first_paid, m.created_at))
           THEN (julianday(COALESCE(ec_max.last_cancel, e.ends_on, date('now', 'localtime'))) - julianday(COALESCE(p_min.first_paid, m.created_at))) / 30.0
           ELSE NULL
         END) AS avg_canceled
       FROM members m
       LEFT JOIN plan_enrollments e ON e.member_id = m.id
       LEFT JOIN (SELECT member_id, MIN(paid_at) AS first_paid FROM payments WHERE status = 'paid' GROUP BY member_id) p_min ON p_min.member_id = m.id
       LEFT JOIN (SELECT member_id, MAX(canceled_at) AS last_cancel FROM enrollment_cancellations GROUP BY member_id) ec_max ON ec_max.member_id = m.id
       WHERE m.access_role = 'student'`,
    );
    const avgPayRow = this.store.get(
      `SELECT AVG(cnt) AS avg_pay FROM (
         SELECT COUNT(*) AS cnt FROM payments p
         JOIN members m ON m.id = p.member_id
         WHERE m.access_role = 'student' AND p.status = 'paid'
         GROUP BY p.member_id
       )`,
    );

    return {
      month,
      financial: {
        mensalidadesCents,
        vendasCents,
        totalCents,
        prevTotalCents,
        growthPct,
        paymentsCount,
        ticketAvgCents,
        byMethod,
        byPlan,
      },
      projections: {
        mrrCents,
        openReceivablesCents,
        projectedMonthEndCents,
        series,
      },
      members: {
        active: activeStudents,
        blocked: blockedStudents,
        pending: pendingStudents,
        newInMonth,
        renewedInMonth,
        canceledInMonth,
        churnRatePct,
        byModality,
      },
      cancellations: {
        total: totalCancellations,
        byReason: cancellationsByReason,
        recent: recentCancellations,
      },
      retention: {
        avgMonthsOverall: Number((retentionRow?.avg_overall || 0).toFixed(1)),
        avgMonthsActive: Number((retentionRow?.avg_active || 0).toFixed(1)),
        avgMonthsCanceled: Number((retentionRow?.avg_canceled || 0).toFixed(1)),
        avgPaymentsPerMember: Number((avgPayRow?.avg_pay || 0).toFixed(1)),
      },
    };
  }

  async freezeMember(memberId, { days = null, until = null, reason = null } = {}) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    if (member.access_role !== 'student') throw new Error('Trancamento disponível apenas para alunos.');

    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    if (member.frozen_until && member.frozen_until >= today) {
      throw Object.assign(new Error('Matrícula já está trancada.'), { statusCode: 409 });
    }

    const monthPrefix = today.slice(0, 7);
    const usedThisMonth = this.store.get(
      'SELECT id FROM member_freezes WHERE member_id = ? AND substr(started_at, 1, 7) = ? LIMIT 1',
      [member.id, monthPrefix],
    );
    if (usedThisMonth) {
      throw Object.assign(new Error('Este aluno já utilizou o trancamento neste mês (limite de 1x por mês).'), { statusCode: 409 });
    }

    let frozenUntil = null;
    if (until) {
      if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('Data final de trancamento inválida.');
      if (until < today) throw new Error('A data de trancamento deve ser a partir de hoje.');
      frozenUntil = until;
    } else if (days !== null && days !== undefined && String(days).trim() !== '') {
      const nDays = Number(days);
      if (!Number.isInteger(nDays) || nDays < 1) throw new Error('Informe uma quantidade de dias válida (mínimo 1 dia) ou deixe em branco.');
      frozenUntil = addDays(today, nDays);
    } else {
      frozenUntil = '9999-12-31';
    }

    const cleanReason = String(reason || '').trim() || 'Trancamento / Férias';
    this.store.transaction(() => {
      this.store.run(
        `UPDATE members SET frozen_until = ?, frozen_started_at = ?, frozen_reason = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [frozenUntil, today, cleanReason, member.id],
      );
      this.store.run(
        `INSERT INTO member_freezes (member_id, started_at, planned_until, reason) VALUES (?, ?, ?, ?)`,
        [member.id, today, frozenUntil === '9999-12-31' ? null : frozenUntil, cleanReason],
      );
    });

    const updated = this.getMember(member.id);
    const sync = await this.trySyncMemberToDevice(updated);
    return { member: this.getMember(member.id), sync };
  }

  async unfreezeMember(memberId) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    if (!member.frozen_until) throw new Error('Matrícula não está trancada.');

    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const updatedDate = typeof member.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(member.updated_at)
      ? member.updated_at.slice(0, 10)
      : null;
    const freezeStart = (updatedDate && (!member.frozen_started_at || updatedDate < member.frozen_started_at))
      ? updatedDate
      : (member.frozen_started_at || today);
    const effectiveEnd = today < member.frozen_until ? today : member.frozen_until;
    const msPerDay = 86400000;
    const elapsedDays = Math.max(0, Math.round((new Date(`${effectiveEnd}T12:00:00Z`) - new Date(`${freezeStart}T12:00:00Z`)) / msPerDay));
    const extendDays = elapsedDays;

    this.store.transaction(() => {
      const enrollment = this.getPlanEnrollment(member.id);
      const baseValid = enrollment?.ends_on || member.valid_until;
      const nextValidUntil = baseValid ? addDays(baseValid, extendDays) : null;
      this.store.run(
        `UPDATE members SET frozen_until = NULL, frozen_started_at = NULL, frozen_reason = NULL, valid_until = COALESCE(?, valid_until), status = CASE WHEN ? IS NOT NULL AND ? >= ? THEN 'active' ELSE status END, updated_at = datetime('now', 'localtime') WHERE id = ?`,
        [nextValidUntil, nextValidUntil, nextValidUntil, this.enrollmentCutoff(today), member.id],
      );
      if (enrollment && nextValidUntil) {
        this.store.run('UPDATE plan_enrollments SET ends_on = ? WHERE member_id = ?', [nextValidUntil, member.id]);
      }
      const openFreeze = this.store.get(
        'SELECT id FROM member_freezes WHERE member_id = ? AND unfrozen_at IS NULL ORDER BY id DESC LIMIT 1',
        [member.id],
      );
      if (openFreeze) {
        this.store.run(
          'UPDATE member_freezes SET unfrozen_at = ?, extended_days = ? WHERE id = ?',
          [today, extendDays, openFreeze.id],
        );
      }
    });

    const updated = this.getMember(member.id);
    const sync = await this.trySyncMemberToDevice(updated);
    return { member: this.getMember(member.id), extendedDays: extendDays, sync };
  }

  async createVisitor({ name, document = null, phone = null, valid_until = null } = {}) {
    if (!name?.trim()) throw new Error('Nome do visitante é obrigatório.');
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const expiresAt = valid_until && /^\d{4}-\d{2}-\d{2}$/.test(String(valid_until).trim())
      ? String(valid_until).trim()
      : today;

    const visitorId = this.store.transaction(() => {
      const cleanDoc = document ? String(document).trim() : null;
      const res = this.store.run(
        `INSERT INTO members (name, document, phone, access_role, status, is_visitor, visitor_expires_at, valid_until)
         VALUES (?, ?, ?, 'student', 'active', 1, ?, ?)`,
        [name.trim(), cleanDoc, phone?.trim() || null, expiresAt, expiresAt],
      );
      const id = res.lastInsertRowid;
      this.store.run('UPDATE members SET controlid_user_id = ? WHERE id = ?', [id, id]);
      return id;
    });

    const visitor = this.getMember(visitorId);
    const sync = await this.trySyncMemberToDevice(visitor);
    return { visitor: this.getMember(visitorId), sync };
  }

  async convertVisitorToMember(memberId, { document, plan_id = null, phone = null, email = null } = {}) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Visitante não encontrado.');
    if (!member.is_visitor) throw new Error('Este cadastro já é um aluno regular.');

    const planId = plan_id ? Number(plan_id) : null;
    if (planId) {
      const plan = this.store.get('SELECT id FROM plans WHERE id = ?', [planId]);
      if (!plan) throw new Error('Plano não encontrado.');
    }

    this.store.transaction(() => {
      const gym = new GymService(this.store);
      const formattedCpf = gym.assertValidAndUniqueCpf(document, member.id);
      const hasEnrollment = Boolean(this.getPlanEnrollment(member.id)?.ends_on);
      this.store.run(
        `UPDATE members
         SET is_visitor = 0,
             visitor_expires_at = NULL,
             document = ?,
             phone = COALESCE(?, phone),
             email = COALESCE(?, email),
             plan_id = COALESCE(?, plan_id),
             status = ?,
             valid_until = CASE WHEN ? THEN valid_until ELSE NULL END,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [
          formattedCpf,
          phone?.trim() || null,
          email?.trim() || null,
          planId,
          hasEnrollment ? 'active' : 'pending',
          hasEnrollment ? 1 : 0,
          member.id,
        ],
      );
    });

    const updated = this.getMember(member.id);
    const sync = await this.trySyncMemberToDevice(updated);
    return { member: this.getMember(member.id), sync };
  }

  signMemberContract(memberId, { signature } = {}) {
    const member = this.getMember(memberId);
    if (!member) throw new Error('Aluno não encontrado.');
    const cleanSig = String(signature || '').trim();
    if (!cleanSig) throw new Error('Assinatura é obrigatória.');

    this.store.run(
      `UPDATE members
       SET parq_signed_at = COALESCE(parq_signed_at, datetime('now', 'localtime')),
           contract_signed_at = datetime('now', 'localtime'),
           contract_signature = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [cleanSig, member.id],
    );
    return this.getMember(member.id);
  }

  async syncAllReaders() {
    if (String(process.env.EDGE_ROLE || '').trim().toLowerCase() === 'cloud') {
      this.edgeCloudHub?.enqueueCommand('sync_all_readers', {});
      return { queuedForEdge: true, totalSynced: 0, totalErrors: 0, readers: [] };
    }
    const readers = this.store.all('SELECT * FROM readers WHERE active = 1 ORDER BY id ASC');
    const members = this.store.all('SELECT * FROM members WHERE face_registered = 1 ORDER BY id ASC');
    const readerResults = [];
    const offlineReaderIds = new Set();
    let totalSynced = 0;
    let totalErrors = 0;

    const isConnectionOrTimeoutError = (err) => {
      if (!err) return false;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
      const code = err.code || err.cause?.code || '';
      if ([
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code)) {
        return true;
      }
      const msg = String(err.message || '').toLowerCase();
      return msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('timed out') || msg.includes('ip do leitor control id não configurado');
    };

    for (const reader of readers) {
      const client = this.controlId.forDevice(reader);
      let synced = 0;
      let errors = 0;
      for (const member of members) {
        if (offlineReaderIds.has(reader.id)) {
          errors += 1;
          totalErrors += 1;
          continue;
        }
        try {
          const allowed = !this.getAccessDenial(member);
          await client.syncMember(member, allowed);
          synced += 1;
          totalSynced += 1;
        } catch (err) {
          errors += 1;
          totalErrors += 1;
          if (isConnectionOrTimeoutError(err)) {
            offlineReaderIds.add(reader.id);
          }
        }
      }
      readerResults.push({
        readerId: reader.id,
        name: reader.name,
        ip: reader.ip,
        synced,
        errors,
        offline: offlineReaderIds.has(reader.id),
      });
    }

    return { readers: readerResults, totalSynced, totalErrors };
  }
}
