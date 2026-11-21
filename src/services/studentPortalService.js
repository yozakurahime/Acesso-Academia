import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, scryptSync } from 'node:crypto';
import { hashPassword, verifyPassword } from './authService.js';

function hashInviteCode(code) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(String(code), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
import { studentFitnessProgress } from './fitnessProgress.js';

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const MAX_PHOTO_DATA_URL_LEN = 2 * 1024 * 1024; // ~1.5MB em base64

export class StudentPortalService {
  constructor(store, gymService) {
    this.store = store;
    this.gymService = gymService;
  }

  _sanitizeMember(row, { includePhoto = true } = {}) {
    if (!row) return null;
    const {
      portal_password_hash,
      portal_invite_hash,
      portal_invite_expires_at,
      portal_token_version,
      notes: _notes,
      last_sync_error: _lastSyncError,
      manual_access: _manualAccess,
      controlid_user_id: _controlidUserId,
      ...safe
    } = row;
    let profilePhoto = safe.profile_photo || null;
    if (includePhoto && !profilePhoto && safe.id && this.store?.filePath) {
      try {
        const facePhotoPath = path.join(path.dirname(this.store.filePath), 'photos', `member_${Number(safe.id)}.jpg`);
        if (fs.existsSync(facePhotoPath)) {
          const buf = fs.readFileSync(facePhotoPath);
          if (buf.length > 0 && buf.length <= 1024 * 1024) {
            profilePhoto = `data:image/jpeg;base64,${buf.toString('base64')}`;
          }
        }
      } catch {}
    }
    return {
      ...safe,
      profile_photo: profilePhoto,
      has_portal_password: Boolean(portal_password_hash),
    };
  }

  findStudentByIdentifier(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return null;

    if (raw.includes('@')) {
      const matches = this.store.all(
        "SELECT * FROM members WHERE access_role = 'student' AND LOWER(TRIM(COALESCE(email, ''))) = LOWER(?)",
        [raw],
      );
      return matches.length === 1 ? matches[0] : null;
    }

    const digits = onlyDigits(raw);
    if (digits.length < 4) return null;

    const noCountry = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    const candidates = this.store.all(
      `SELECT * FROM members
       WHERE access_role = 'student'
         AND (
           replace(replace(replace(replace(replace(replace(COALESCE(document, ''), '.', ''), '-', ''), '/', ''), ' ', ''), '(', ''), ')', '') = ?
           OR replace(replace(replace(replace(replace(replace(replace(COALESCE(phone, ''), '.', ''), '-', ''), '/', ''), ' ', ''), '(', ''), ')', ''), '+', '') IN (?, ?, ?)
         )`,
      [digits, digits, noCountry, `55${noCountry}`],
    );
    const matches = candidates.filter((m) => {
      const docDigits = onlyDigits(m.document);
      const phoneDigits = onlyDigits(m.phone);
      const phoneNoCountry = phoneDigits.startsWith('55') && phoneDigits.length >= 12 ? phoneDigits.slice(2) : phoneDigits;
      return (
        (docDigits && docDigits === digits) ||
        (phoneDigits && (phoneDigits === digits || phoneNoCountry === noCountry))
      );
    });
    return matches.length === 1 ? matches[0] : null;
  }

  issueInvite(memberId) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += alphabet[randomInt(alphabet.length)];
    }
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const result = this.store.run("UPDATE members SET portal_invite_hash = ?, portal_invite_expires_at = ? WHERE id = ? AND access_role = 'student' AND portal_password_hash IS NULL",
      [hashInviteCode(code), expiresAt, Number(memberId)]);
    if (!result.changes) throw httpError('Aluno não encontrado ou já possui senha.', 409);
    return { code, expiresAt };
  }

  authenticateStudent(identifier, secret) {
    const member = this.findStudentByIdentifier(identifier);
    if (!member) {
      throw httpError('Identificador ou credencial inválidos.', 401);
    }

    const provided = String(secret || '').trim();
    if (!provided) {
      throw httpError('Informe a senha ou o código de convite.', 400);
    }

    if (member.portal_password_hash) {
      if (!verifyPassword(provided, member.portal_password_hash)) {
        throw httpError('Senha incorreta.', 401);
      }
      return this._sanitizeMember(member);
    }

    if (
      !member.portal_invite_hash ||
      !member.portal_invite_expires_at ||
      member.portal_invite_expires_at <= Date.now() ||
      !verifyPassword(provided.toUpperCase(), member.portal_invite_hash)
    ) {
      throw httpError('Identificador ou credencial inválidos. Solicite um convite à recepção.', 401);
    }
    return this._sanitizeMember(member);
  }

  getStudentProfile(memberId, { includePhoto = true } = {}) {
    const row = this.store.get(
      `SELECT m.*,
              p.name AS plan_name,
              p.duration_days AS plan_duration_days,
              p.price_cents AS plan_price_cents,
              mo.name AS modality_name
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN modalities mo ON mo.id = m.modality_id
       WHERE m.id = ? AND m.access_role = 'student'`,
      [Number(memberId)],
    );
    if (!row) throw httpError('Aluno não encontrado.', 404);

    const plans = this.store.all(
      `SELECT *
       FROM plans
       WHERE active = 1
         AND price_cents > 0
         AND (COALESCE(online_available, 1) = 1 OR id = ?)
       ORDER BY duration_days ASC, price_cents ASC, name ASC`,
      [Number(row.plan_id || 0)],
    );
    const payments = this.store.all(
      `SELECT pay.*, pl.name AS plan_name
       FROM payments pay
       LEFT JOIN plans pl ON pl.id = pay.plan_id
       WHERE pay.member_id = ?
       ORDER BY pay.paid_at DESC, pay.id DESC
       LIMIT 20`,
      [Number(memberId)],
    );
    const modalities = this.store.all(
      `SELECT mo.id, mo.name
       FROM member_modalities mm
       JOIN modalities mo ON mo.id = mm.modality_id
       WHERE mm.member_id = ?
       ORDER BY mo.name ASC`,
      [Number(memberId)],
    );
    const enrollments = this.store.all(
      `SELECT ce.id, c.id AS class_id, c.name AS class_name, c.schedule, mo.name AS modality_name, i.name AS instructor_name
       FROM class_enrollments ce
       JOIN classes c ON c.id = ce.class_id
       JOIN modalities mo ON mo.id = c.modality_id
       LEFT JOIN instructors i ON i.id = c.instructor_id
       WHERE ce.member_id = ?
       ORDER BY c.name ASC`,
      [Number(memberId)],
    );
    const workouts = this.gymService.listWorkoutsByMember(memberId, { activeOnly: true });
    const settings = this.store.getSettings();
    const gymName = settings.gym_name || 'Academia Oxigênio';
    const planEnrollment = this.store.get(
      `SELECT e.*, p.name AS plan_name
       FROM plan_enrollments e
       LEFT JOIN plans p ON p.id = e.plan_id
       WHERE e.member_id = ?`,
      [Number(memberId)],
    ) || null;
    const openDebtsCents = Number(
      this.store.get(
        "SELECT COALESCE(SUM(amount_cents - paid_cents), 0) AS total FROM member_debts WHERE member_id = ? AND status = 'open'",
        [Number(memberId)],
      )?.total || 0,
    );
    const nextCharge = this.store.get(
      'SELECT id, due, amount FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due ASC, id ASC LIMIT 1',
      [Number(memberId)],
    ) || null;
    const recentCheckins = this.store.all(
      `SELECT id, event_code, event_label, occurred_at
       FROM access_logs
       WHERE member_id = ? AND event_code IN (7, 11, 12)
       ORDER BY id DESC
       LIMIT 10`,
      [Number(memberId)],
    );

    return {
      gymName,
      pixRecipientKey: settings.pix_recipient_key || '',
      pixRecipientName: settings.pix_recipient_name || '',
      member: {
        ...this._sanitizeMember(row, { includePhoto }),
        valid_until: planEnrollment?.ends_on || row.valid_until || null,
        plan_starts_on: planEnrollment?.starts_on || null,
        open_debt_cents: openDebtsCents,
        next_charge: nextCharge,
      },
      plans,
      payments,
      modalities,
      enrollments,
      workouts,
      recentCheckins,
      fitness: studentFitnessProgress(this.store, Number(memberId)),
    };
  }

  updateExerciseLoad(memberId, exerciseId, loadKg) {
    const ex = this.store.get(
      `SELECT e.id, e.workout_id
       FROM workout_exercises e
       JOIN workouts w ON w.id = e.workout_id
       WHERE e.id = ? AND w.member_id = ? AND w.active = 1`,
      [Number(exerciseId), Number(memberId)],
    );
    if (!ex) throw httpError('Exercício não encontrado no seu treino.', 404);
    const cleaned = loadKg == null ? null : String(loadKg).trim().slice(0, 32) || null;
    this.store.run('UPDATE workout_exercises SET load_kg = ? WHERE id = ?', [cleaned, ex.id]);
    return { id: ex.id, workout_id: ex.workout_id, load_kg: cleaned };
  }

  updateContactInfo(memberId, { phone, email, emergency_contact } = {}) {
    const member = this.store.get("SELECT * FROM members WHERE id = ? AND access_role = 'student'", [Number(memberId)]);
    if (!member) throw httpError('Aluno não encontrado.', 404);
    const nextPhone = phone !== undefined ? (String(phone || '').trim().slice(0, 30) || null) : member.phone;
    const nextEmail = email !== undefined ? (String(email || '').trim().slice(0, 120) || null) : member.email;
    const nextEmergency = emergency_contact !== undefined ? (String(emergency_contact || '').trim().slice(0, 120) || null) : member.emergency_contact;
    this.store.run(
      "UPDATE members SET phone = ?, email = ?, emergency_contact = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [nextPhone, nextEmail, nextEmergency, member.id],
    );
    return this._sanitizeMember(this.store.get('SELECT * FROM members WHERE id = ?', [member.id]));
  }

  /**
   * Atualiza APENAS a foto de perfil do portal do aluno (`members.profile_photo`).
   * Nunca altera a foto biométrica / FaceID da catraca (`controlid_user_id` / `face_registered`).
   */
  updateProfilePhoto(memberId, profilePhotoDataUrl) {
    const member = this.store.get("SELECT id FROM members WHERE id = ? AND access_role = 'student'", [Number(memberId)]);
    if (!member) throw httpError('Aluno não encontrado.', 404);

    if (!profilePhotoDataUrl) {
      this.store.run(
        "UPDATE members SET profile_photo = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [Number(memberId)],
      );
      return { profile_photo: null };
    }

    const dataUrl = String(profilePhotoDataUrl).trim();
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) {
      throw httpError('Formato de imagem inválido. Use JPG, PNG ou WebP.', 400);
    }
    if (dataUrl.length > MAX_PHOTO_DATA_URL_LEN) {
      throw httpError('A imagem é muito grande. Reduza ou escolha uma foto menor (máx. 1,5 MB).', 413);
    }

    this.store.run(
      "UPDATE members SET profile_photo = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [dataUrl, Number(memberId)],
    );
    return { profile_photo: dataUrl };
  }

  updatePortalPassword(memberId, { current_password = '', new_password, force = false } = {}) {
    const member = this.store.get("SELECT id, portal_password_hash FROM members WHERE id = ? AND access_role = 'student'", [Number(memberId)]);
    if (!member) throw httpError('Aluno não encontrado.', 404);

    if (!force && member.portal_password_hash && !verifyPassword(current_password, member.portal_password_hash)) {
      throw httpError('A senha atual está incorreta.', 401);
    }

    const hash = hashPassword(new_password);
    this.store.run(
      "UPDATE members SET portal_password_hash = ?, portal_invite_hash = NULL, portal_invite_expires_at = NULL, portal_token_version = COALESCE(portal_token_version, 1) + 1, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [hash, Number(memberId)],
    );
    return { ok: true, has_portal_password: true };
  }
}
