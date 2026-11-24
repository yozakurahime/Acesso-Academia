import { formatCpf, isValidCpf, normalizeCpf } from '../utils/cpf.js';
import { normalizePartnerInput } from './partnerService.js';
import { calculatePaymentFee } from './feeUtils.js';

function normalizeMemberName(name) {
  return String(name || '').normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export class GymService {
  constructor(store) {
    this.store = store;
  }

  // --- Perfil do Aluno ---
  getMemberProfile(memberId) {
    const id = Number(memberId);
    const member = this.store.get(
      `SELECT m.*, p.name AS plan_name, p.price_cents AS plan_price_cents,
              mod.name AS modality_name
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN modalities mod ON mod.id = m.modality_id
       WHERE m.id = ?`,
      [id],
    );
    if (!member) throw new Error('Aluno nao encontrado.');

    const payments = this.store.all(
      `SELECT pay.*, p.name AS plan_name, s.name AS staff_name
       FROM payments pay
       LEFT JOIN plans p ON p.id = pay.plan_id
       LEFT JOIN staff s ON s.id = pay.staff_id
       WHERE pay.member_id = ?
       ORDER BY pay.id DESC LIMIT 50`,
      [id],
    );

    const gatewayCharges = this.store.all(
      `SELECT gc.id, gc.provider, gc.external_id, gc.plan_id, gc.amount_cents,
              gc.status, gc.payment_id, gc.created_at, gc.paid_at,
              p.name AS plan_name
       FROM gateway_charges gc
       LEFT JOIN plans p ON p.id = gc.plan_id
       WHERE gc.member_id = ?
       ORDER BY gc.id DESC LIMIT 30`,
      [id],
    );

    const pointOrders = this.store.all(
      `SELECT po.id, po.order_id, po.terminal_id, po.plan_id, po.amount_cents,
              po.payment_method, po.status, po.payment_id, po.created_at, po.paid_at,
              p.name AS plan_name
       FROM point_orders po
       LEFT JOIN plans p ON p.id = po.plan_id
       WHERE po.member_id = ?
       ORDER BY po.id DESC LIMIT 30`,
      [id],
    );

    const logs = this.store.all(
      `SELECT * FROM access_logs
       WHERE member_id = ? OR controlid_user_id = ?
       ORDER BY id DESC LIMIT 20`,
      [id, member.controlid_user_id || -1],
    );

    const classes = this.store.all(
      `SELECT c.*, mod.name AS modality_name, i.name AS instructor_name
       FROM class_enrollments ce
       JOIN classes c ON c.id = ce.class_id
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       WHERE ce.member_id = ?`,
      [id],
    );

    const modalities = this.store.all(
      `SELECT mo.id, mo.name FROM modalities mo WHERE
       mo.id = ? OR EXISTS (SELECT 1 FROM member_modalities mm WHERE mm.member_id = ? AND mm.modality_id = mo.id)
       OR mo.id IN (SELECT c.modality_id FROM classes c JOIN class_enrollments ce ON ce.class_id = c.id WHERE ce.member_id = ?)
       ORDER BY mo.name`, [member.modality_id, id, id],
    ).map((modality) => ({ ...modality, classes: classes.filter((cls) => cls.modality_id === modality.id) }));

    const planEnrollment = this.store.get(`SELECT e.*, p.name AS plan_name FROM plan_enrollments e
      LEFT JOIN plans p ON p.id = e.plan_id WHERE e.member_id = ?`, [id]);
    const { today, cutoff } = this.store.get("SELECT date('now', 'localtime') AS today, date('now', 'localtime', ?) AS cutoff",
      [`-${Math.max(0, Math.floor(Number(this.store.getSettings().tolerance_days) || 0))} days`]);
    const inGrace = Boolean(planEnrollment?.plan_name && planEnrollment.ends_on >= cutoff && planEnrollment.ends_on < today);
    const { portal_password_hash, portal_invite_hash, portal_invite_expires_at, ...profileMember } = member;
    const weeklyGoal = this.store.get('SELECT weekly_goal FROM student_fitness_preferences WHERE member_id = ?', [id])?.weekly_goal ?? 3;
    const openCharges = this.store.all(
      `SELECT id, member_id, due, amount
       FROM membership_charges
       WHERE member_id = ? AND payment_id IS NULL
       ORDER BY due ASC, id ASC`,
      [id],
    );
    return { member: { ...profileMember, has_portal_password: Boolean(portal_password_hash) }, payments, gatewayCharges, pointOrders, logs, classes, modalities, planEnrollment, inGrace, weeklyGoal, openCharges };
  }

  updateMember(memberId, data) {
    const id = Number(memberId);
    const existing = this.store.get('SELECT * FROM members WHERE id = ?', [id]);
    if (!existing) throw new Error('Aluno nao encontrado.');
    const name = data.name?.trim() || existing.name;
    if (normalizeMemberName(name) !== normalizeMemberName(existing.name)) this.assertUniqueMemberName(name, id);
    const hasPartnerFields = Object.hasOwn(data, 'partner_provider') || Object.hasOwn(data, 'wellhub_id');
    const nextPartner = hasPartnerFields
      ? normalizePartnerInput({
          partner_provider: Object.hasOwn(data, 'partner_provider') ? data.partner_provider : existing.partner_provider,
          wellhub_id: Object.hasOwn(data, 'wellhub_id') ? data.wellhub_id : existing.wellhub_id,
        })
      : { partner_provider: existing.partner_provider || null, wellhub_id: existing.wellhub_id || null };
    if (nextPartner.partner_provider === 'wellhub') {
      this.assertUniqueWellhubId(nextPartner.wellhub_id, id);
    }
    const allowEmptyLegacyCpf =
      !normalizeCpf(data.document) &&
      !normalizeCpf(existing.document);
    const nextDocument = Object.hasOwn(data, 'document')
      ? (allowEmptyLegacyCpf ? (existing.document || null) : this.assertValidAndUniqueCpf(data.document, id))
      : existing.document;
    const nextStatus =
      existing.access_role === 'student' && nextPartner.partner_provider && existing.status !== 'active'
        ? 'active'
        : existing.status;

    this.store.run(
      `UPDATE members
       SET name = ?, document = ?, phone = ?, email = ?,
           birth_date = ?, sex = ?, address = ?, emergency_contact = ?, notes = ?,
           modality_id = ?, plan_id = ?, partner_provider = ?, wellhub_id = ?, status = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [
        name,
        nextDocument,
        data.phone ?? existing.phone,
        data.email ?? existing.email,
        Object.hasOwn(data, 'birth_date') ? data.birth_date || null : existing.birth_date,
        Object.hasOwn(data, 'sex') ? data.sex || null : existing.sex,
        data.address ?? existing.address,
        data.emergency_contact ?? existing.emergency_contact,
        data.notes ?? existing.notes,
        Object.hasOwn(data, 'modality_id') ? (data.modality_id ? Number(data.modality_id) : null) : existing.modality_id,
        Object.hasOwn(data, 'plan_id') ? (data.plan_id ? Number(data.plan_id) : null) : existing.plan_id,
        nextPartner.partner_provider,
        nextPartner.wellhub_id,
        nextStatus,
        id,
      ],
    );

    return this.getMemberProfile(id);
  }

  assertUniqueWellhubId(wellhubId, memberId = 0) {
    const clean = String(wellhubId || '').trim();
    if (!clean) return;
    const existing = this.store.get(
      'SELECT id, name FROM members WHERE id <> ? AND lower(trim(wellhub_id)) = lower(?) LIMIT 1',
      [Number(memberId) || 0, clean],
    );
    if (existing) {
      const err = new Error(`Já existe um cadastro com esse ID Wellhub (${existing.name}, ID #${existing.id}).`);
      err.statusCode = 409;
      throw err;
    }
  }

  assertUniqueMemberName(name, memberId = 0) {
    const normalized = normalizeMemberName(name);
    const existing = this.store.all(
      'SELECT id, name FROM members WHERE id <> ? ORDER BY id',
      [memberId],
    ).find((member) => normalizeMemberName(member.name) === normalized);
    if (existing) {
      const err = new Error(`Já existe um cadastro com esse nome (ID #${existing.id}). Confira o cadastro existente.`);
      err.statusCode = 409;
      throw err;
    }
  }

  checkMemberName(name) {
    const normalized = normalizeMemberName(name);
    if (!normalized) throw new Error('Informe o nome do aluno.');
    const matchedIds = this.store.all('SELECT id, name FROM members ORDER BY id')
      .filter((member) => normalizeMemberName(member.name) === normalized)
      .slice(0, 6)
      .map((member) => member.id);
    const matches = matchedIds.length
      ? this.store.all(
          `SELECT id, name, document, phone, status, access_role FROM members
           WHERE id IN (${matchedIds.map(() => '?').join(', ')}) ORDER BY id`,
          matchedIds,
        ).map((member) => ({ ...member, reason: 'exact' }))
      : [];
    const exactMatch = matches.length > 0;
    return {
      valid: !exactMatch,
      exactMatch,
      matches,
    };
  }

  findMemberByCpf(cpf, excludeId = 0) {
    const digits = normalizeCpf(cpf);
    if (!digits) return null;
    const formatted = formatCpf(digits);
    return this.store.get(
      `SELECT id, name, document, phone, status, access_role FROM members
       WHERE id <> ? AND (document = ? OR document = ? OR replace(replace(replace(COALESCE(document, ''), '.', ''), '-', ''), ' ', '') = ?)
       ORDER BY id LIMIT 1`,
      [Number(excludeId) || 0, formatted, digits, digits],
    );
  }

  assertValidAndUniqueCpf(document, memberId = 0) {
    const digits = normalizeCpf(document);
    if (!digits) {
      const err = new Error('CPF é obrigatório.');
      err.statusCode = 400;
      throw err;
    }
    if (!isValidCpf(digits)) {
      const err = new Error('CPF inválido. Confira os dígitos informados.');
      err.statusCode = 400;
      throw err;
    }
    const existing = this.findMemberByCpf(digits, memberId);
    if (existing) {
      const err = new Error(`Já existe um cadastro com esse CPF (${existing.name}, ID #${existing.id}).`);
      err.statusCode = 409;
      throw err;
    }
    return formatCpf(digits);
  }

  checkMemberCpf(cpf, excludeId = 0) {
    const digits = normalizeCpf(cpf);
    if (!digits) return { valid: false, reason: 'empty', message: 'Informe o CPF.' };
    if (!isValidCpf(digits)) return { valid: false, reason: 'invalid', message: 'CPF inválido.' };
    const existing = this.findMemberByCpf(digits, excludeId);
    if (existing) {
      return {
        valid: false,
        reason: 'duplicate',
        message: `CPF já cadastrado para ${existing.name} (ID #${existing.id}).`,
        match: existing,
      };
    }
    return { valid: true, formatted: formatCpf(digits), message: 'CPF válido.' };
  }

  // --- Modalidades, Professores e Turmas ---
  listModalities() {
    return this.store.all('SELECT * FROM modalities ORDER BY name ASC');
  }

  createModality({ name, description }) {
    if (!name?.trim()) throw new Error('Nome da modalidade e obrigatorio.');
    const trimmed = name.trim();
    const duplicate = this.store.get('SELECT id FROM modalities WHERE lower(trim(name)) = lower(?)', [trimmed]);
    if (duplicate) throw new Error('Ja existe uma modalidade com este nome.');
    const res = this.store.run('INSERT INTO modalities (name, description) VALUES (?, ?)', [
      trimmed,
      description?.trim() || null,
    ]);
    return this.store.get('SELECT * FROM modalities WHERE id = ?', [res.lastInsertRowid]);
  }

  updateModality(id, { name, description }) {
    const modalityId = Number(id);
    const existing = this.store.get('SELECT * FROM modalities WHERE id = ?', [modalityId]);
    if (!existing) throw new Error('Modalidade não encontrada.');
    if (!name?.trim()) throw new Error('Nome da modalidade e obrigatorio.');
    const trimmed = name.trim();
    const duplicate = this.store.get('SELECT id FROM modalities WHERE lower(trim(name)) = lower(?) AND id != ?', [
      trimmed,
      modalityId,
    ]);
    if (duplicate) throw new Error('Ja existe uma modalidade com este nome.');
    this.store.run('UPDATE modalities SET name = ?, description = ? WHERE id = ?', [
      trimmed,
      description?.trim() || null,
      modalityId,
    ]);
    return this.store.get('SELECT * FROM modalities WHERE id = ?', [modalityId]);
  }

  deleteModality(id) {
    const modalityId = Number(id);
    const existing = this.store.get('SELECT * FROM modalities WHERE id = ?', [modalityId]);
    if (!existing) throw new Error('Modalidade não encontrada.');
    this.store.transaction(() => {
      this.store.run('UPDATE members SET modality_id = NULL WHERE modality_id = ?', [modalityId]);
      this.store.run('DELETE FROM member_modalities WHERE modality_id = ?', [modalityId]);
      this.store.run('UPDATE classes SET modality_id = NULL WHERE modality_id = ?', [modalityId]);
      this.store.run('DELETE FROM modalities WHERE id = ?', [modalityId]);
    });
    return { deleted: true, id: modalityId };
  }

  listInstructors() {
    return this.store.all('SELECT * FROM instructors ORDER BY name ASC');
  }

  createInstructor({ name, phone, specialty }) {
    if (!name?.trim()) throw new Error('Nome do professor e obrigatorio.');
    const res = this.store.run('INSERT INTO instructors (name, phone, specialty) VALUES (?, ?, ?)', [
      name.trim(),
      phone?.trim() || null,
      specialty?.trim() || null,
    ]);
    return this.store.get('SELECT * FROM instructors WHERE id = ?', [res.lastInsertRowid]);
  }

  listClasses() {
    return this.store.all(
      `SELECT c.*, mod.name AS modality_name, i.name AS instructor_name,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
       FROM classes c
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       ORDER BY c.name ASC`,
    );
  }

  createClass({
    name,
    modality_id,
    instructor_id,
    schedule,
    capacity,
    allow_new_enrollments,
    online_enrollment_mode,
  }) {
    if (!name?.trim() || !schedule?.trim()) {
      throw new Error('Nome da turma e horario sao obrigatorios.');
    }
    const cleanName = name.trim();
    const cleanSchedule = schedule.trim();
    const lower = cleanName.toLowerCase();
    let resolvedCapacity = capacity != null && capacity !== '' ? Number(capacity) : 20;
    if (lower.includes('hidro')) resolvedCapacity = Math.min(resolvedCapacity, 15);
    if (lower.includes('nata') && lower.includes('adult')) resolvedCapacity = Math.min(resolvedCapacity, 6);

    const isPilates18 = lower.includes('pilates') && (cleanSchedule.includes('18') || lower.includes('18'));
    const resolvedAllowNew = allow_new_enrollments != null
      ? (Number(allow_new_enrollments) ? 1 : 0)
      : (isPilates18 ? 0 : 1);

    const isKidsSwim = (lower.includes('nata') || lower.includes('baby'))
      && (lower.includes('infantil') || lower.includes('baby') || lower.includes('crian'));
    const resolvedOnlineMode = online_enrollment_mode
      || (isKidsSwim ? 'reception_only' : 'auto');

    const res = this.store.run(
      `INSERT INTO classes (name, modality_id, instructor_id, schedule, capacity, allow_new_enrollments, online_enrollment_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        cleanName,
        modality_id ? Number(modality_id) : null,
        instructor_id ? Number(instructor_id) : null,
        cleanSchedule,
        resolvedCapacity,
        resolvedAllowNew,
        resolvedOnlineMode,
      ],
    );
    return this.store.get('SELECT * FROM classes WHERE id = ?', [res.lastInsertRowid]);
  }

  updateClass(id, payload = {}) {
    const cls = this.store.get('SELECT * FROM classes WHERE id = ?', [Number(id)]);
    if (!cls) throw new Error('Turma nao encontrada.');
    const nextName = payload.name !== undefined ? String(payload.name).trim() : cls.name;
    const nextSchedule = payload.schedule !== undefined ? String(payload.schedule).trim() : cls.schedule;
    if (!nextName || !nextSchedule) {
      throw new Error('Nome da turma e horario sao obrigatorios.');
    }
    const nextModalityId = payload.modality_id !== undefined
      ? (payload.modality_id ? Number(payload.modality_id) : null)
      : cls.modality_id;
    const nextInstructorId = payload.instructor_id !== undefined
      ? (payload.instructor_id ? Number(payload.instructor_id) : null)
      : cls.instructor_id;
    const nextCapacity = payload.capacity !== undefined ? Math.max(1, Number(payload.capacity || cls.capacity)) : cls.capacity;
    const nextActive = payload.active !== undefined ? (Number(payload.active) ? 1 : 0) : cls.active;
    const nextAllowNew = payload.allow_new_enrollments !== undefined
      ? (Number(payload.allow_new_enrollments) ? 1 : 0)
      : (cls.allow_new_enrollments ?? 1);
    const nextOnlineMode = payload.online_enrollment_mode !== undefined
      ? (payload.online_enrollment_mode === 'reception_only' ? 'reception_only' : 'auto')
      : (cls.online_enrollment_mode || 'auto');

    this.store.run(
      `UPDATE classes
       SET name = ?, modality_id = ?, instructor_id = ?, schedule = ?, capacity = ?, active = ?, allow_new_enrollments = ?, online_enrollment_mode = ?
       WHERE id = ?`,
      [nextName, nextModalityId, nextInstructorId, nextSchedule, nextCapacity, nextActive, nextAllowNew, nextOnlineMode, cls.id],
    );
    return this.store.get(
      `SELECT c.*, mod.name AS modality_name, i.name AS instructor_name,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
       FROM classes c
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       WHERE c.id = ?`,
      [cls.id],
    );
  }

  deleteClass(id) {
    const classId = Number(id);
    const cls = this.store.get('SELECT id, name FROM classes WHERE id = ?', [classId]);
    if (!cls) throw new Error('Turma nao encontrada.');
    this.store.run('DELETE FROM class_enrollments WHERE class_id = ?', [classId]);
    this.store.run('DELETE FROM class_bookings WHERE class_id = ?', [classId]);
    this.store.run('DELETE FROM classes WHERE id = ?', [classId]);
    return { ok: true, id: classId };
  }

  listClassMembers(classId) {
    const cls = this.store.get(
      `SELECT c.*, mod.name AS modality_name, i.name AS instructor_name
       FROM classes c
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       WHERE c.id = ?`,
      [Number(classId)],
    );
    if (!cls) throw new Error('Turma nao encontrada.');
    const members = this.store.all(
      `SELECT m.id, m.name, m.phone, m.status, m.valid_until, p.name AS plan_name, ce.enrolled_at
       FROM class_enrollments ce
       JOIN members m ON m.id = ce.member_id
       LEFT JOIN plans p ON p.id = m.plan_id
       WHERE ce.class_id = ?
       ORDER BY m.name ASC`,
      [cls.id],
    );
    return { class: cls, members };
  }

  removeMemberFromClass(classId, memberId) {
    const cls = this.store.get('SELECT id FROM classes WHERE id = ?', [Number(classId)]);
    if (!cls) throw new Error('Turma nao encontrada.');
    this.store.run('DELETE FROM class_enrollments WHERE class_id = ? AND member_id = ?', [cls.id, Number(memberId)]);
    return { ok: true };
  }

  enrollMemberInClass(classId, memberId) {
    const cls = this.store.get('SELECT * FROM classes WHERE id = ?', [Number(classId)]);
    if (!cls) throw new Error('Turma nao encontrada.');
    if (cls.active === 0) throw new Error('Esta turma esta inativa.');
    const member = this.store.get('SELECT id FROM members WHERE id = ?', [Number(memberId)]);
    if (!member) throw new Error('Aluno não encontrado.');
    if (this.store.get('SELECT 1 FROM class_enrollments WHERE class_id = ? AND member_id = ?', [cls.id, member.id])) return { ok: true };
    if (cls.allow_new_enrollments === 0) throw new Error('Esta turma esta fechada para novas matriculas.');
    const count = this.store.get('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?', [cls.id])?.c ?? 0;
    if (count >= cls.capacity) throw new Error('Turma sem vagas disponiveis.');

    this.store.run('INSERT OR IGNORE INTO class_enrollments (class_id, member_id) VALUES (?, ?)', [
      cls.id,
      Number(memberId),
    ]);
    return { ok: true };
  }

  validateEnrollment(memberId, modalityId, classId) {
    if (!this.store.get('SELECT id FROM modalities WHERE id = ?', [modalityId])) throw new Error('Modalidade não encontrada.');
    if (classId == null) return;
    const cls = this.store.get('SELECT * FROM classes WHERE id = ? AND modality_id = ?', [classId, modalityId]);
    if (!cls) throw new Error('Selecione uma turma da modalidade escolhida.');
    const alreadyEnrolled = this.store.get('SELECT 1 FROM class_enrollments WHERE class_id = ? AND member_id = ?', [classId, memberId]);
    if (!alreadyEnrolled && cls.allow_new_enrollments === 0) throw new Error('Esta turma esta fechada para novas matriculas.');
    const count = this.store.get('SELECT COUNT(*) AS count FROM class_enrollments WHERE class_id = ? AND member_id <> ?', [classId, memberId]);
    if (count.count >= cls.capacity) throw new Error('Esta turma está lotada.');
  }

  saveEnrollment(memberId, { modality_id, class_id = null, previous_modality_id = null }) {
    const id = Number(memberId);
    const modalityId = Number(modality_id);
    const previousId = Number(previous_modality_id);
    const classId = class_id == null || class_id === '' ? null : Number(class_id);
    this.store.transaction(() => {
      const member = this.store.get('SELECT modality_id FROM members WHERE id = ?', [id]);
      if (!member) throw new Error('Aluno não encontrado.');
      this.validateEnrollment(id, modalityId, classId);
      if (previousId && previousId !== modalityId) {
        if (!this.hasEnrollment(id, previousId, member.modality_id)) throw new Error('Matrícula não encontrada.');
        if (this.hasEnrollment(id, modalityId, member.modality_id)) throw new Error('O aluno já está matriculado nessa modalidade.');
        this.clearEnrollment(id, previousId);
      }
      this.store.run('INSERT OR IGNORE INTO member_modalities (member_id, modality_id) VALUES (?, ?)', [id, modalityId]);
      this.store.run(`DELETE FROM class_enrollments WHERE member_id = ? AND class_id IN
        (SELECT id FROM classes WHERE modality_id = ?) AND class_id <> COALESCE(?, -1)`, [id, modalityId, classId]);
      if (classId != null) this.store.run('INSERT OR IGNORE INTO class_enrollments (class_id, member_id) VALUES (?, ?)', [classId, id]);
      if (!member.modality_id || member.modality_id === previousId) {
        this.store.run('UPDATE members SET modality_id = ? WHERE id = ?', [modalityId, id]);
      }
    });
    return this.getMemberProfile(id);
  }

  hasEnrollment(memberId, modalityId, primaryId) {
    return primaryId === modalityId || Boolean(this.store.get(
      `SELECT 1 FROM member_modalities WHERE member_id = ? AND modality_id = ?
       UNION SELECT 1 FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id WHERE ce.member_id = ? AND c.modality_id = ?`,
      [memberId, modalityId, memberId, modalityId],
    ));
  }

  clearEnrollment(memberId, modalityId) {
    this.store.run('DELETE FROM member_modalities WHERE member_id = ? AND modality_id = ?', [memberId, modalityId]);
    this.store.run('DELETE FROM class_enrollments WHERE member_id = ? AND class_id IN (SELECT id FROM classes WHERE modality_id = ?)', [memberId, modalityId]);
  }

  removeEnrollment(memberId, modalityId) {
    const id = Number(memberId);
    const modality = Number(modalityId);
    this.store.transaction(() => {
      const member = this.store.get('SELECT modality_id FROM members WHERE id = ?', [id]);
      if (!member || !this.hasEnrollment(id, modality, member.modality_id)) throw new Error('Matrícula não encontrada.');
      this.clearEnrollment(id, modality);
      if (member.modality_id === modality) {
        const next = this.getMemberProfile(id).modalities.find((entry) => entry.id !== modality);
        this.store.run('UPDATE members SET modality_id = ? WHERE id = ?', [next?.id ?? null, id]);
      }
    });
    return this.getMemberProfile(id);
  }

  // --- Atendentes (Equipe) ---
  listStaff() {
    return this.store.all('SELECT * FROM staff ORDER BY name ASC');
  }

  createStaff({ name, role, phone }) {
    if (!name?.trim()) throw new Error('Nome do atendente e obrigatorio.');
    const res = this.store.run('INSERT INTO staff (name, role, phone) VALUES (?, ?, ?)', [
      name.trim(),
      role?.trim() || 'Atendente',
      phone?.trim() || null,
    ]);
    return this.store.get('SELECT * FROM staff WHERE id = ?', [res.lastInsertRowid]);
  }

  // --- Formas de Pagamento ---
  listPaymentMethods() {
    return this.store.all('SELECT * FROM payment_methods ORDER BY id ASC');
  }

  createPaymentMethod({ code, name }) {
    if (!name?.trim()) throw new Error('Nome da forma de pagamento e obrigatorio.');
    const slug = (code || name)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_');
    const res = this.store.run('INSERT INTO payment_methods (code, name) VALUES (?, ?)', [slug, name.trim()]);
    return this.store.get('SELECT * FROM payment_methods WHERE id = ?', [res.lastInsertRowid]);
  }

  togglePaymentMethod(id) {
    const pm = this.store.get('SELECT * FROM payment_methods WHERE id = ?', [Number(id)]);
    if (!pm) throw new Error('Forma de pagamento nao encontrada.');
    const next = pm.active ? 0 : 1;
    this.store.run('UPDATE payment_methods SET active = ? WHERE id = ?', [next, pm.id]);
    return this.store.get('SELECT * FROM payment_methods WHERE id = ?', [pm.id]);
  }

  // --- Produtos e Vendas (PDV) ---
  listProducts() {
    return this.store.all('SELECT * FROM products ORDER BY name ASC');
  }

  createProduct({ name, category, price_cents, stock }) {
    if (!name?.trim() || !price_cents) throw new Error('Nome e preco do produto sao obrigatorios.');
    if (!Number.isSafeInteger(Number(price_cents)) || Number(price_cents) <= 0 ||
        !Number.isSafeInteger(Number(stock ?? 0)) || Number(stock ?? 0) < 0) throw new Error('Informe preço positivo em centavos e estoque inteiro.');
    const res = this.store.run(
      'INSERT INTO products (name, category, price_cents, stock) VALUES (?, ?, ?, ?)',
      [name.trim(), category?.trim() || 'Geral', Number(price_cents), Number(stock || 0)],
    );
    return this.store.get('SELECT * FROM products WHERE id = ?', [res.lastInsertRowid]);
  }

  listSales(limit = 30) {
    return this.store.all(
      `SELECT s.*, p.name AS product_name, m.name AS member_name, m.document AS member_document
       FROM sales s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN members m ON m.id = s.member_id
       ORDER BY s.id DESC LIMIT ?`,
      [Number(limit)],
    );
  }

  recordSale({ product_id, member_id = null, quantity = 1, method = 'pix', staff_id = null }) {
    const product = this.store.get('SELECT * FROM products WHERE id = ?', [Number(product_id)]);
    if (!product) throw new Error('Produto nao encontrado.');
    if (product.active === 0) throw new Error('Produto inativo.');
    const qty = Number(quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('Quantidade inválida. Informe um número inteiro.');
    if (product.stock < qty) throw new Error(`Estoque insuficiente para ${product.name}.`);

    const totalCents = product.price_cents * qty;
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error('Total da venda inválido.');
    const saleId = this.store.transaction(() => {
      const stockUpdate = this.store.run(
        'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
        [qty, product.id, qty],
      );
      if (stockUpdate.changes !== 1) {
        throw new Error(`Estoque insuficiente para ${product.name}.`);
      }

      const res = this.store.run(
        'INSERT INTO sales (product_id, member_id, quantity, total_cents, method, staff_id) VALUES (?, ?, ?, ?, ?, ?)',
        [product.id, member_id ? Number(member_id) : null, qty, totalCents, method, staff_id ? Number(staff_id) : null],
      );

      this.recordCashMovementIfOpen({
        type: 'sale',
        amount_cents: totalCents,
        method,
        description: `Venda: ${qty}x ${product.name}`,
      });

      return res.lastInsertRowid;
    });

    return this.store.get('SELECT * FROM sales WHERE id = ?', [saleId]);
  }

  // --- Caixa Completo ---
  _buildCashSessionSummary(session) {
    if (!session) return null;

    const settings = this.store.getSettings();
    const movements = this.store.all(
      'SELECT * FROM cash_movements WHERE session_id = ? ORDER BY id DESC',
      [session.id],
    );

    let totalIn = 0;
    let totalOut = 0;
    let totalFee = 0;
    let drawerBalance = session.opening_cents;
    const totalsByMethod = new Map();
    const enrichedMovements = [];
    for (const mov of movements) {
      const isRevenue = mov.type === 'payment' || mov.type === 'sale';
      const feeInfo = isRevenue
        ? calculatePaymentFee(mov.amount_cents, mov.method, settings, { channel: 'point' })
        : { gross_cents: mov.amount_cents, fee_pct: 0, fee_cents: 0, net_cents: mov.amount_cents };
      enrichedMovements.push({
        ...mov,
        fee_pct: feeInfo.fee_pct,
        fee_cents: feeInfo.fee_cents,
        net_cents: feeInfo.net_cents,
      });

      if (mov.type === 'out') totalOut += mov.amount_cents;
      else totalIn += mov.amount_cents;
      if (isRevenue) totalFee += feeInfo.fee_cents;
      if (mov.method === 'cash') drawerBalance += mov.type === 'out' ? -mov.amount_cents : mov.amount_cents;
      if (mov.type !== 'out') {
        const prev = totalsByMethod.get(mov.method) || { amount_cents: 0, fee_cents: 0, net_cents: 0 };
        prev.amount_cents += mov.amount_cents;
        prev.fee_cents += feeInfo.fee_cents;
        prev.net_cents += mov.type === 'in' ? mov.amount_cents : feeInfo.net_cents;
        totalsByMethod.set(mov.method, prev);
      }
    }

    return {
      ...session,
      total_in_cents: totalIn,
      total_fee_cents: totalFee,
      total_net_in_cents: Math.max(0, totalIn - totalFee),
      total_out_cents: totalOut,
      expected_cents: session.status === 'closed' && session.expected_cents != null ? session.expected_cents : drawerBalance,
      totals_by_method: [...totalsByMethod].map(([method, entry]) => ({ method, ...entry })),
      movements: enrichedMovements,
    };
  }

  getCurrentCashSession() {
    const session = this.store.get("SELECT * FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    return this._buildCashSessionSummary(session);
  }

  getCashSessionDetails(sessionId) {
    const session = this.store.get('SELECT * FROM cash_sessions WHERE id = ?', [Number(sessionId)]);
    if (!session) throw new Error('Turno de caixa não encontrado.');
    return this._buildCashSessionSummary(session);
  }

  openCashSession({ staff_id = null, opening_cents = 0, notes = null }) {
    if (!Number.isSafeInteger(Number(opening_cents)) || Number(opening_cents) < 0) throw new Error('Saldo inicial inválido.');
    const existing = this.getCurrentCashSession();
    if (existing) throw new Error('Ja existe um caixa aberto. Feche o caixa atual antes de abrir outro.');

    const staff = staff_id ? this.store.get('SELECT * FROM staff WHERE id = ?', [Number(staff_id)]) : null;
    const res = this.store.run(
      'INSERT INTO cash_sessions (staff_id, staff_name, opening_cents, notes) VALUES (?, ?, ?, ?)',
      [staff?.id || null, staff?.name || 'Recepção', Number(opening_cents || 0), notes || null],
    );
    return this.getCurrentCashSession() || this.store.get('SELECT * FROM cash_sessions WHERE id = ?', [res.lastInsertRowid]);
  }

  recordCashMovementIfOpen({ type, amount_cents, method = 'cash', description }) {
    const session = this.store.get("SELECT * FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    if (!session) return null;
    const res = this.store.run(
      'INSERT INTO cash_movements (session_id, type, amount_cents, method, description) VALUES (?, ?, ?, ?, ?)',
      [session.id, type, Number(amount_cents), method, description],
    );
    return this.store.get('SELECT * FROM cash_movements WHERE id = ?', [res.lastInsertRowid]);
  }

  addManualCashMovement({ type, amount_cents, method = 'cash', description }) {
    if (!['in', 'out'].includes(type)) throw new Error('Tipo de movimentacao deve ser in ou out.');
    if (!Number.isSafeInteger(Number(amount_cents)) || Number(amount_cents) <= 0) throw new Error('Valor inválido.');
    const session = this.getCurrentCashSession();
    if (!session) throw new Error('Abra o caixa antes de registrar movimentacoes.');

    return this.recordCashMovementIfOpen({
      type,
      amount_cents: Number(amount_cents),
      method,
      description: description?.trim() || (type === 'in' ? 'Suprimento de caixa' : 'Sangria de caixa'),
    });
  }

  closeCashSession({ closing_cents, notes = null }) {
    const session = this.getCurrentCashSession();
    if (!session) throw new Error('Nao ha caixa aberto para fechar.');
    if (closing_cents != null && (!Number.isSafeInteger(Number(closing_cents)) || Number(closing_cents) < 0)) throw new Error('Valor conferido inválido.');

    this.store.run(
      `UPDATE cash_sessions
       SET status = 'closed',
           closing_cents = ?,
           expected_cents = ?,
           notes = COALESCE(?, notes),
           closed_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [Number(closing_cents ?? session.expected_cents), session.expected_cents, notes, session.id],
    );

    return this.store.get('SELECT * FROM cash_sessions WHERE id = ?', [session.id]);
  }

  listCashHistory(limit = 20) {
    return this.store.all('SELECT * FROM cash_sessions ORDER BY id DESC LIMIT ?', [Number(limit)]);
  }

  // --- Treinos dos Alunos ---
  listWorkoutsByMember(memberId, { activeOnly = false } = {}) {
    const where = activeOnly ? 'WHERE w.member_id = ? AND w.active = 1' : 'WHERE w.member_id = ?';
    const workouts = this.store.all(
      `SELECT w.*, i.name AS instructor_name
       FROM workouts w
       LEFT JOIN instructors i ON i.id = w.instructor_id
       ${where}
       ORDER BY w.active DESC, w.id ASC`,
      [Number(memberId)],
    );
    if (!workouts.length) return [];
    const ids = workouts.map((w) => w.id);
    const allExercises = this.store.all(
      `SELECT e.*, c.video_file IS NOT NULL AS has_video, c.tips AS catalog_tips
       FROM workout_exercises e LEFT JOIN exercise_catalog c ON c.key = e.exercise_key
       WHERE e.workout_id IN (${ids.map(() => '?').join(',')}) ORDER BY e.sort_order ASC, e.id ASC`,
      ids,
    );
    const byWorkout = new Map();
    for (const ex of allExercises) {
      if (!byWorkout.has(ex.workout_id)) byWorkout.set(ex.workout_id, []);
      byWorkout.get(ex.workout_id).push(ex);
    }
    return workouts.map((w) => ({
      ...w,
      exercises: byWorkout.get(w.id) || [],
    }));
  }

  listWorkoutTemplates() {
    return this.store.all('SELECT * FROM workout_templates ORDER BY title COLLATE NOCASE, id')
      .map((row) => {
        let exercises = [];
        try {
          exercises = JSON.parse(row.exercises);
        } catch {
          exercises = [];
        }
        return { ...row, exercises: Array.isArray(exercises) ? exercises : [] };
      });
  }

  saveWorkoutTemplate({ title, goal, notes, exercises }, id = null) {
    const name = typeof title === 'string' ? title.trim() : '';
    if (!name) throw new Error('Informe o nome do modelo.');
    if (!Array.isArray(exercises) || !exercises.length || exercises.length > 60) throw new Error('Adicione de 1 a 60 exercícios.');
    const text = (value) => typeof value === 'string' ? value.trim() : '';
    const rows = exercises.map((exercise) => {
      const sets = Number(exercise?.sets);
      const rest = Number(exercise?.rest_seconds);
      if (!text(exercise?.exercise_name) || !text(exercise?.reps) || !Number.isSafeInteger(sets) || sets < 1 ||
          !Number.isSafeInteger(rest) || rest < 0) throw new Error('Confira o nome, as séries, as repetições e o descanso dos exercícios.');
      return {
        exercise_key: text(exercise.exercise_key) || 'custom', exercise_name: text(exercise.exercise_name),
        muscle_group: text(exercise.muscle_group), sets, reps: text(exercise.reps), rest_seconds: rest,
        load_kg: text(exercise.load_kg) || null, notes: text(exercise.notes) || null,
      };
    });
    const values = [name, text(goal) || null, text(notes) || null, JSON.stringify(rows)];
    if (id == null) {
      id = this.store.run('INSERT INTO workout_templates (title, goal, notes, exercises) VALUES (?, ?, ?, ?)', values).lastInsertRowid;
    } else {
      const result = this.store.run('UPDATE workout_templates SET title = ?, goal = ?, notes = ?, exercises = ? WHERE id = ?', [...values, Number(id)]);
      if (!result.changes) throw new Error('Modelo não encontrado.');
    }
    return { id: Number(id), title: name, goal: values[1], notes: values[2], exercises: rows };
  }

  deleteWorkoutTemplate(id) {
    if (!this.store.run('DELETE FROM workout_templates WHERE id = ?', [Number(id)]).changes) throw new Error('Modelo não encontrado.');
    return { deleted: true };
  }

  getWorkoutById(workoutId) {
    const workout = this.store.get(
      `SELECT w.*, i.name AS instructor_name
       FROM workouts w
       LEFT JOIN instructors i ON i.id = w.instructor_id
       WHERE w.id = ?`,
      [Number(workoutId)],
    );
    if (!workout) return null;
    workout.exercises = this.store.all(
      'SELECT * FROM workout_exercises WHERE workout_id = ? ORDER BY sort_order ASC, id ASC',
      [workout.id],
    );
    return workout;
  }

  _replaceWorkoutExercises(workoutId, exercises = []) {
    this.store.run('DELETE FROM workout_exercises WHERE workout_id = ?', [Number(workoutId)]);
    exercises.forEach((ex, idx) => {
      const name = String(ex.exercise_name || '').trim();
      if (!name) return;
      this.store.run(
        `INSERT INTO workout_exercises
         (workout_id, exercise_key, exercise_name, muscle_group, sets, reps, rest_seconds, load_kg, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(workoutId),
          String(ex.exercise_key || 'custom').trim(),
          name,
          ex.muscle_group ? String(ex.muscle_group).trim() : null,
          Math.max(1, Number(ex.sets || 3)),
          String(ex.reps || '12').trim(),
          Math.max(0, Number(ex.rest_seconds ?? 60)),
          ex.load_kg ? String(ex.load_kg).trim() : null,
          ex.notes ? String(ex.notes).trim() : null,
          Number(ex.sort_order ?? idx),
        ],
      );
    });
  }

  createWorkout({ member_id, title, goal = null, instructor_id = null, notes = null, exercises = [] }) {
    const member = this.store.get('SELECT id FROM members WHERE id = ?', [Number(member_id)]);
    if (!member) throw new Error('Aluno nao encontrado.');
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('Titulo do treino e obrigatorio.');

    const workoutId = this.store.transaction(() => {
      const res = this.store.run(
        `INSERT INTO workouts (member_id, title, goal, instructor_id, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [
          Number(member_id),
          cleanTitle,
          goal ? String(goal).trim() : null,
          instructor_id ? Number(instructor_id) : null,
          notes ? String(notes).trim() : null,
        ],
      );
      if (Array.isArray(exercises) && exercises.length) {
        this._replaceWorkoutExercises(res.lastInsertRowid, exercises);
      }
      return res.lastInsertRowid;
    });

    return this.getWorkoutById(workoutId);
  }

  updateWorkout(workoutId, { title, goal, instructor_id, notes, active, exercises }) {
    const existing = this.store.get('SELECT * FROM workouts WHERE id = ?', [Number(workoutId)]);
    if (!existing) throw new Error('Treino nao encontrado.');

    const nextTitle = title !== undefined ? String(title || '').trim() : existing.title;
    if (!nextTitle) throw new Error('Titulo do treino e obrigatorio.');

    this.store.transaction(() => {
      this.store.run(
        `UPDATE workouts
         SET title = ?,
             goal = ?,
             instructor_id = ?,
             notes = ?,
             active = ?,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [
          nextTitle,
          goal !== undefined ? (goal ? String(goal).trim() : null) : existing.goal,
          instructor_id !== undefined ? (instructor_id ? Number(instructor_id) : null) : existing.instructor_id,
          notes !== undefined ? (notes ? String(notes).trim() : null) : existing.notes,
          active !== undefined ? (active ? 1 : 0) : existing.active,
          Number(workoutId),
        ],
      );
      if (Array.isArray(exercises)) {
        this._replaceWorkoutExercises(workoutId, exercises);
      }
    });

    return this.getWorkoutById(workoutId);
  }

  deleteWorkout(workoutId) {
    const existing = this.store.get('SELECT id FROM workouts WHERE id = ?', [Number(workoutId)]);
    if (!existing) throw new Error('Treino nao encontrado.');
    this.store.transaction(() => {
      this.store.run('DELETE FROM workout_exercises WHERE workout_id = ?', [Number(workoutId)]);
      this.store.run('DELETE FROM workouts WHERE id = ?', [Number(workoutId)]);
    });
    return { deleted: true, id: Number(workoutId) };
  }

  // --- Avaliações Físicas ---
  listAssessments(memberId) {
    const id = Number(memberId);
    const member = this.store.get('SELECT id FROM members WHERE id = ?', [id]);
    if (!member) throw new Error('Aluno nao encontrado.');
    return this.store.all(
      'SELECT * FROM body_assessments WHERE member_id = ? ORDER BY assessed_at DESC, id DESC',
      [id],
    );
  }

  createAssessment(memberId, data = {}) {
    const id = Number(memberId);
    const member = this.store.get('SELECT id FROM members WHERE id = ?', [id]);
    if (!member) throw new Error('Aluno nao encontrado.');

    const numOrNull = (val) => {
      if (val === undefined || val === null || val === '') return null;
      const n = Number(val);
      return Number.isFinite(n) ? n : null;
    };

    const assessedAt = data.assessed_at
      ? String(data.assessed_at).trim()
      : this.store.get("SELECT date('now', 'localtime') AS d").d;

    const res = this.store.run(
      `INSERT INTO body_assessments (
         member_id, assessed_at, weight_kg, height_cm, body_fat_pct, muscle_mass_kg,
         chest_cm, waist_cm, hip_cm, arm_cm, thigh_cm, notes, assessed_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        assessedAt,
        numOrNull(data.weight_kg),
        numOrNull(data.height_cm),
        numOrNull(data.body_fat_pct),
        numOrNull(data.muscle_mass_kg),
        numOrNull(data.chest_cm),
        numOrNull(data.waist_cm),
        numOrNull(data.hip_cm),
        numOrNull(data.arm_cm),
        numOrNull(data.thigh_cm),
        data.notes ? String(data.notes).trim() : null,
        data.assessed_by ? String(data.assessed_by).trim() : null,
      ],
    );
    return this.store.get('SELECT * FROM body_assessments WHERE id = ?', [res.lastInsertRowid]);
  }

  deleteAssessment(id) {
    const assessmentId = Number(id);
    const existing = this.store.get('SELECT id FROM body_assessments WHERE id = ?', [assessmentId]);
    if (!existing) throw new Error('Avaliacao nao encontrada.');
    this.store.run('DELETE FROM body_assessments WHERE id = ?', [assessmentId]);
    return { deleted: true, id: assessmentId };
  }

  // --- Agendamento de Aulas & Lista de Espera ---
  listClassBookings(classId, bookingDate) {
    const cid = Number(classId);
    if (bookingDate) {
      return this.store.all(
        `SELECT cb.*, m.name AS member_name, m.phone AS member_phone
         FROM class_bookings cb
         LEFT JOIN members m ON m.id = cb.member_id
         WHERE cb.class_id = ? AND cb.booking_date = ?
         ORDER BY cb.id ASC`,
        [cid, String(bookingDate).trim()],
      );
    }
    return this.store.all(
      `SELECT cb.*, m.name AS member_name, m.phone AS member_phone
       FROM class_bookings cb
       LEFT JOIN members m ON m.id = cb.member_id
       WHERE cb.class_id = ?
       ORDER BY cb.booking_date ASC, cb.id ASC`,
      [cid],
    );
  }

  listMemberBookings(memberId) {
    const id = Number(memberId);
    return this.store.all(
      `SELECT cb.*, c.name AS class_name, c.schedule, c.capacity,
              mod.name AS modality_name, i.name AS instructor_name
       FROM class_bookings cb
       JOIN classes c ON c.id = cb.class_id
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       WHERE cb.member_id = ? AND cb.status != 'canceled'
       ORDER BY cb.booking_date ASC, cb.id ASC`,
      [id],
    );
  }

  bookClass({ classId, memberId, bookingDate }) {
    const cid = Number(classId);
    const mid = Number(memberId);
    const date = String(bookingDate || '').trim();
    if (!date) throw Object.assign(new Error('Data da reserva e obrigatoria.'), { statusCode: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw Object.assign(new Error('Informe a data da reserva no formato YYYY-MM-DD.'), { statusCode: 400 });
    }
    const today = this.store.get("SELECT date('now', 'localtime') AS d")?.d;
    if (today && date < today) {
      throw Object.assign(new Error('Nao e possivel reservar turma em data passada.'), { statusCode: 400 });
    }

    const cls = this.store.get('SELECT * FROM classes WHERE id = ?', [cid]);
    if (!cls) throw Object.assign(new Error('Turma nao encontrada.'), { statusCode: 404 });
    if (cls.allow_new_enrollments === 0) {
      throw Object.assign(new Error('Esta turma nao esta aceitando novas reservas no momento.'), { statusCode: 409 });
    }

    const member = this.store.get('SELECT id FROM members WHERE id = ?', [mid]);
    if (!member) throw Object.assign(new Error('Aluno nao encontrado.'), { statusCode: 404 });

    const duplicate = this.store.get(
      `SELECT id FROM class_bookings
       WHERE class_id = ? AND member_id = ? AND booking_date = ? AND status IN ('confirmed', 'waitlist')`,
      [cid, mid, date],
    );
    if (duplicate) throw Object.assign(new Error('Aluno ja possui reserva para esta turma nesta data.'), { statusCode: 409 });

    return this.store.transaction(() => {
      const { cnt } = this.store.get(
        `SELECT COUNT(*) AS cnt FROM class_bookings
         WHERE class_id = ? AND booking_date = ? AND status = 'confirmed'`,
        [cid, date],
      );
      const status = Number(cnt) >= Number(cls.capacity || 0) ? 'waitlist' : 'confirmed';
      const res = this.store.run(
        `INSERT INTO class_bookings (class_id, member_id, booking_date, status)
         VALUES (?, ?, ?, ?)`,
        [cid, mid, date, status],
      );
      return this.store.get('SELECT * FROM class_bookings WHERE id = ?', [res.lastInsertRowid]);
    });
  }

  cancelClassBooking(bookingId, memberId) {
    const id = Number(bookingId);
    return this.store.transaction(() => {
      const booking = this.store.get('SELECT * FROM class_bookings WHERE id = ?', [id]);
      if (!booking) throw Object.assign(new Error('Reserva nao encontrada.'), { statusCode: 404 });
      if (memberId !== undefined && memberId !== null && Number(booking.member_id) !== Number(memberId)) {
        throw Object.assign(new Error('Reserva nao pertence a este aluno.'), { statusCode: 403 });
      }
      if (booking.status === 'canceled') {
        return { canceled: true, id, promoted: null };
      }

      this.store.run("UPDATE class_bookings SET status = 'canceled' WHERE id = ?", [id]);

      let promoted = null;
      if (booking.status === 'confirmed') {
        const nextWaitlist = this.store.get(
          `SELECT * FROM class_bookings
           WHERE class_id = ? AND booking_date = ? AND status = 'waitlist'
           ORDER BY id ASC LIMIT 1`,
          [booking.class_id, booking.booking_date],
        );
        if (nextWaitlist) {
          this.store.run("UPDATE class_bookings SET status = 'confirmed' WHERE id = ?", [nextWaitlist.id]);
          promoted = this.store.get('SELECT * FROM class_bookings WHERE id = ?', [nextWaitlist.id]);
        }
      }

      return { canceled: true, id, promoted };
    });
  }

  markBookingAttendance(bookingId, status) {
    const id = Number(bookingId);
    const allowed = ['attended', 'no_show', 'confirmed'];
    if (!allowed.includes(status)) {
      throw Object.assign(new Error('Status de presença inválido. Use attended, no_show ou confirmed.'), { statusCode: 400 });
    }
    const booking = this.store.get('SELECT * FROM class_bookings WHERE id = ?', [id]);
    if (!booking) throw Object.assign(new Error('Reserva não encontrada.'), { statusCode: 404 });
    if (booking.status === 'canceled') {
      throw Object.assign(new Error('Não é possível marcar presença em reserva cancelada.'), { statusCode: 409 });
    }
    this.store.run('UPDATE class_bookings SET status = ? WHERE id = ?', [status, id]);
    return this.store.get('SELECT * FROM class_bookings WHERE id = ?', [id]);
  }

  bookClassRecurring({ classId, memberId, startDate, weeks = 4 }) {
    const base = String(startDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) {
      throw Object.assign(new Error('Informe a data inicial no formato YYYY-MM-DD.'), { statusCode: 400 });
    }
    const totalWeeks = Math.min(12, Math.max(1, Math.round(Number(weeks || 4))));
    const created = [];
    const skipped = [];
    const [yr, mo, dy] = base.split('-').map(Number);

    for (let i = 0; i < totalWeeks; i++) {
      const d = new Date(Date.UTC(yr, mo - 1, dy + i * 7, 12, 0, 0));
      const iso = d.toISOString().slice(0, 10);
      try {
        created.push(this.bookClass({ classId, memberId, bookingDate: iso }));
      } catch (err) {
        skipped.push({ booking_date: iso, reason: err.message });
      }
    }
    return { created, skipped };
  }

  // --- Gamificação ---
  getMemberGamification(memberId) {
    const id = Number(memberId);
    const member = this.store.get('SELECT id FROM members WHERE id = ?', [id]);
    if (!member) throw new Error('Aluno nao encontrado.');

    const totalVisits = this.store.get(
      `SELECT COUNT(*) AS cnt FROM access_logs
       WHERE member_id = ? AND event_code IN (7, 11, 12)`,
      [id],
    )?.cnt || 0;

    const monthVisits = this.store.get(
      `SELECT COUNT(*) AS cnt FROM access_logs
       WHERE member_id = ? AND event_code IN (7, 11, 12)
         AND substr(occurred_at, 1, 7) = strftime('%Y-%m', 'now', 'localtime')`,
      [id],
    )?.cnt || 0;

    const weekRows = this.store.all(
      `SELECT DISTINCT date(substr(occurred_at, 1, 10), 'weekday 0', '-6 days') AS week_start
       FROM access_logs
       WHERE member_id = ? AND event_code IN (7, 11, 12)
       ORDER BY week_start DESC`,
      [id],
    ).map((r) => r.week_start).filter(Boolean);

    const { currentWeek, prevWeek } = this.store.get(
      `SELECT date('now', 'localtime', 'weekday 0', '-6 days') AS currentWeek,
              date('now', 'localtime', 'weekday 0', '-13 days') AS prevWeek`,
    );

    let weeklyStreak = 0;
    if (weekRows.length && (weekRows[0] === currentWeek || weekRows[0] === prevWeek)) {
      let expected = weekRows[0];
      for (const week of weekRows) {
        if (week !== expected) break;
        weeklyStreak += 1;
        const d = new Date(`${expected}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 7);
        expected = d.toISOString().slice(0, 10);
      }
    }

    const badgeDefs = [
      { key: 'first_visit', label: 'Primeiro Treino', description: 'Registrou sua primeira entrada na academia.', earned: totalVisits >= 1 },
      { key: 'visits_10', label: '10 Visitas', description: 'Completou 10 visitas na academia.', earned: totalVisits >= 10 },
      { key: 'visits_50', label: '50 Visitas', description: 'Completou 50 visitas na academia.', earned: totalVisits >= 50 },
      { key: 'visits_100', label: '100 Visitas', description: 'Completou 100 visitas na academia.', earned: totalVisits >= 100 },
      { key: 'month_12', label: 'Foco Mensal', description: '12 ou mais visitas neste mês.', earned: monthVisits >= 12 },
      { key: 'streak_4', label: 'Sequência 4 Semanas', description: '4 semanas seguidas treinando.', earned: weeklyStreak >= 4 },
    ];

    const badges = badgeDefs.filter((b) => b.earned).map(({ key, label, description }) => ({ key, label, description }));

    return {
      monthVisits: Number(monthVisits),
      totalVisits: Number(totalVisits),
      weeklyStreak,
      badges,
    };
  }
}
