import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { seedExerciseCatalog } from './services/exerciseCatalog.js';

/**
 * Wrapper sobre sql.js (SQLite em WebAssembly) com persistencia em disco e migracoes idempotentes.
 */
export class DatabaseStore {
  constructor(db, filePath = null) {
    this.db = db;
    this.filePath = filePath;
  }

  static async create(filePath = null) {
    const SQL = await initSqlJs();
    let db;

    if (filePath && fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      db = new SQL.Database(buffer);
      const check = db.exec('PRAGMA integrity_check');
      const status = check?.[0]?.values?.[0]?.[0];
      if (status !== 'ok') {
        throw new Error(`Banco de dados corrompido (${filePath}): ${status || 'falha de integridade'}`);
      }
      DatabaseStore.createDailyBackup(filePath);
    } else {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    const store = new DatabaseStore(db, filePath);
    store.migrate();
    store.seedDefaults();
    seedExerciseCatalog(store);
    return store;
  }

  static createDailyBackup(filePath, retainCount = 7) {
    try {
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(path.resolve(os.tmpdir()))) return;
      const dir = path.join(path.dirname(filePath), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const base = path.basename(filePath, path.extname(filePath));
      const ext = path.extname(filePath) || '.sqlite';
      const backupPath = path.join(dir, `${base}-${stamp}${ext}`);
      if (!fs.existsSync(backupPath)) {
        const photos = path.join(path.dirname(filePath), 'photos');
        if (fs.existsSync(photos)) fs.cpSync(photos, `${backupPath}.photos`, { recursive: true });
        fs.copyFileSync(filePath, backupPath);
      }
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${base}-`) && f.endsWith(ext))
        .sort();
      while (files.length > retainCount) {
        const oldest = files.shift();
        fs.rmSync(path.join(dir, oldest), { force: true });
        fs.rmSync(path.join(dir, `${oldest}.photos`), { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('[BACKUP] Falha ao criar cópia local:', err.message);
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data = this.db.export();
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(data), { flush: true });
    fs.renameSync(temporaryPath, this.filePath);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows[0] ?? null;
  }

  run(sql, params = []) {
    if (this.filePath && !this.inTransaction) return this.transaction(() => this.run(sql, params));
    const stmt = this.db.prepare(sql);
    try { stmt.run(params); } finally { stmt.free(); }
    const lastIdRow = this.get('SELECT last_insert_rowid() AS id');
    const changesRow = this.get('SELECT changes() AS changes');
    return {
      lastInsertRowid: lastIdRow?.id ?? null,
      changes: changesRow?.changes ?? 0,
    };
  }

  transaction(work) {
    this.db.run('BEGIN');
    this.inTransaction = true;
    let result;
    try {
      result = work();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
    try {
      this.save();
    } catch (err) {
      // O arquivo anterior permanece intacto até a troca atômica.
      const restored = new this.db.constructor(fs.readFileSync(this.filePath));
      restored.run('PRAGMA foreign_keys = ON');
      this.db.close();
      this.db = restored;
      throw err;
    }
    return result;
  }

  ensureColumns(tableName, columns) {
    const existing = new Set(this.all(`PRAGMA table_info(${tableName})`).map((c) => c.name));
    for (const [col, definition] of Object.entries(columns)) {
      if (!existing.has(col)) {
        this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${col} ${definition}`);
      }
    }
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        allowed_start_time TEXT,
        allowed_end_time TEXT,
        weekly_limit INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS payment_methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Atendente',
        phone TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS modalities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS instructors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        specialty TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        modality_id INTEGER REFERENCES modalities(id),
        instructor_id INTEGER REFERENCES instructors(id),
        schedule TEXT NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 20,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        document TEXT,
        phone TEXT,
        email TEXT,
        birth_date TEXT,
        sex TEXT,
        manual_access INTEGER NOT NULL DEFAULT 0,
        access_role TEXT NOT NULL DEFAULT 'student',
        address TEXT,
        emergency_contact TEXT,
        notes TEXT,
        modality_id INTEGER REFERENCES modalities(id),
        plan_id INTEGER REFERENCES plans(id),
        status TEXT NOT NULL DEFAULT 'pending',
        valid_until TEXT,
        controlid_user_id INTEGER,
        face_registered INTEGER NOT NULL DEFAULT 0,
        last_sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS class_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        member_id INTEGER NOT NULL REFERENCES members(id),
        enrolled_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(class_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS member_modalities (
        member_id INTEGER NOT NULL REFERENCES members(id),
        modality_id INTEGER NOT NULL REFERENCES modalities(id),
        PRIMARY KEY (member_id, modality_id)
      );

      CREATE TABLE IF NOT EXISTS plan_enrollments (
        member_id INTEGER PRIMARY KEY REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        starts_on TEXT,
        ends_on TEXT
      );

      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        amount_cents INTEGER NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        staff_id INTEGER REFERENCES staff(id),
        external_id TEXT,
        notes TEXT,
        paid_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'Geral',
        price_cents INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS membership_charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        due TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        payment_id INTEGER UNIQUE REFERENCES payments(id),
        UNIQUE (member_id, due)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER REFERENCES members(id),
        phone TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref_key TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_member_kind ON whatsapp_logs(member_id, kind, created_at);

      CREATE TABLE IF NOT EXISTS payment_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        sender_phone TEXT,
        source TEXT NOT NULL DEFAULT 'whatsapp',
        mime_type TEXT,
        amount_cents INTEGER,
        paid_date TEXT,
        payer_name TEXT,
        payer_document TEXT,
        recipient_name TEXT,
        recipient_key TEXT,
        transaction_id TEXT,
        confidence INTEGER DEFAULT 0,
        is_receipt INTEGER DEFAULT 1,
        raw_summary TEXT,
        image_data TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reject_reason TEXT,
        payment_id INTEGER REFERENCES payments(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payment_receipts_status ON payment_receipts(status, id);
      CREATE INDEX IF NOT EXISTS idx_payment_receipts_tx ON payment_receipts(transaction_id);

      CREATE TABLE IF NOT EXISTS gateway_charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        member_id INTEGER NOT NULL REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        qr_code TEXT,
        qr_base64 TEXT,
        payment_url TEXT,
        payment_id INTEGER REFERENCES payments(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        paid_at TEXT,
        UNIQUE (provider, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_charges_status ON gateway_charges(status, id);

      CREATE TABLE IF NOT EXISTS mp_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        preapproval_id TEXT NOT NULL UNIQUE,
        external_ref TEXT NOT NULL,
        member_id INTEGER NOT NULL REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        amount_cents INTEGER NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        frequency_type TEXT NOT NULL DEFAULT 'months',
        payer_email TEXT,
        init_point TEXT,
        next_payment_date TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT,
        canceled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mp_subscriptions_member ON mp_subscriptions(member_id, status);

      CREATE TABLE IF NOT EXISTS point_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL UNIQUE,
        terminal_id TEXT NOT NULL,
        member_id INTEGER NOT NULL REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        amount_cents INTEGER NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'credit',
        status TEXT NOT NULL DEFAULT 'pending',
        payment_id INTEGER REFERENCES payments(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_point_orders_status ON point_orders(status, id);

      CREATE TABLE IF NOT EXISTS enrollment_cancellations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        plan_id INTEGER REFERENCES plans(id),
        reason TEXT NOT NULL,
        notes TEXT,
        canceled_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_cancellations_date ON enrollment_cancellations(canceled_at);

      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        member_id INTEGER REFERENCES members(id),
        quantity INTEGER NOT NULL DEFAULT 1,
        total_cents INTEGER NOT NULL,
        method TEXT NOT NULL,
        staff_id INTEGER REFERENCES staff(id),
        sold_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS cash_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id INTEGER REFERENCES staff(id),
        staff_name TEXT,
        opening_cents INTEGER NOT NULL DEFAULT 0,
        closing_cents INTEGER,
        expected_cents INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        notes TEXT,
        opened_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cash_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
        type TEXT NOT NULL, -- in | out | sale | payment
        amount_cents INTEGER NOT NULL,
        method TEXT NOT NULL DEFAULT 'cash',
        description TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        controlid_log_id INTEGER UNIQUE,
        controlid_user_id INTEGER,
        member_id INTEGER REFERENCES members(id),
        member_name TEXT,
        event_code INTEGER,
        event_label TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workout_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        goal TEXT,
        notes TEXT,
        exercises TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        title TEXT NOT NULL,
        goal TEXT,
        instructor_id INTEGER REFERENCES instructors(id),
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS exercise_catalog (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        muscle_group TEXT NOT NULL,
        equipment TEXT NOT NULL,
        tips TEXT NOT NULL DEFAULT '',
        uses_equipment INTEGER NOT NULL CHECK (uses_equipment IN (0, 1)),
        video_file TEXT
      );

      CREATE TABLE IF NOT EXISTS workout_exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        exercise_key TEXT NOT NULL,
        exercise_name TEXT NOT NULL,
        muscle_group TEXT,
        sets INTEGER NOT NULL DEFAULT 3,
        reps TEXT NOT NULL DEFAULT '12',
        rest_seconds INTEGER NOT NULL DEFAULT 60,
        load_kg TEXT,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS student_fitness_preferences (
        member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        weekly_goal INTEGER NOT NULL DEFAULT 3 CHECK (weekly_goal BETWEEN 1 AND 7),
        ranking_alias TEXT
      );

      CREATE TABLE IF NOT EXISTS student_workout_completions (
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        workout_id INTEGER NOT NULL,
        completed_on TEXT NOT NULL,
        PRIMARY KEY (member_id, workout_id, completed_on)
      );

      CREATE TABLE IF NOT EXISTS member_credit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        delta_cents INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        reason TEXT,
        payment_id INTEGER REFERENCES payments(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS partner_checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        identifier TEXT NOT NULL,
        checkin_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'validated',
        external_id TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS whatsapp_chats (
        phone TEXT PRIMARY KEY,
        contact_name TEXT,
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        bot_paused INTEGER NOT NULL DEFAULT 0,
        needs_human INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message TEXT,
        last_message_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS whatsapp_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_wa_chat_msgs_phone ON whatsapp_chat_messages(phone, id);

      CREATE TABLE IF NOT EXISTS turnstiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        driver TEXT NOT NULL DEFAULT 'toletus',
        ip TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 7878,
        release_seconds INTEGER NOT NULL DEFAULT 5,
        default_direction TEXT NOT NULL DEFAULT 'entry',
        free_side TEXT NOT NULL DEFAULT 'none',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS readers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT 'controlid',
        ip TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 80,
        username TEXT NOT NULL DEFAULT 'admin',
        password TEXT NOT NULL DEFAULT 'admin',
        action_mode TEXT NOT NULL DEFAULT 'sec_box',
        secbox_id INTEGER NOT NULL DEFAULT 65793,
        group_id INTEGER NOT NULL DEFAULT 1,
        direction TEXT NOT NULL DEFAULT 'entry',
        turnstile_id INTEGER REFERENCES turnstiles(id) ON DELETE SET NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'geral',
        amount_cents INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        paid_at TEXT,
        payment_method TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS commissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id INTEGER,
        staff_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id INTEGER,
        description TEXT,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        paid_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS body_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL,
        assessed_at TEXT NOT NULL DEFAULT (date('now','localtime')),
        weight_kg REAL,
        height_cm REAL,
        body_fat_pct REAL,
        muscle_mass_kg REAL,
        chest_cm REAL,
        waist_cm REAL,
        hip_cm REAL,
        arm_cm REAL,
        thigh_cm REAL,
        notes TEXT,
        assessed_by TEXT
      );

      CREATE TABLE IF NOT EXISTS class_bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        member_id INTEGER NOT NULL,
        booking_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'reception',
        staff_id INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_members_controlid ON members(controlid_user_id);
      CREATE INDEX IF NOT EXISTS idx_members_document ON members(document);
      CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
      CREATE INDEX IF NOT EXISTS idx_members_status_valid ON members(status, valid_until);
      CREATE INDEX IF NOT EXISTS idx_access_logs_member ON access_logs(member_id);
      CREATE INDEX IF NOT EXISTS idx_access_logs_occurred_at ON access_logs(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_access_logs_member_event_time ON access_logs(member_id, event_code, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id);
      CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments(paid_at);
      CREATE INDEX IF NOT EXISTS idx_workouts_member ON workouts(member_id);
      CREATE INDEX IF NOT EXISTS idx_workout_exercises_workout ON workout_exercises(workout_id);
      CREATE INDEX IF NOT EXISTS idx_partner_checkins_member_date ON partner_checkins(member_id, checkin_date);
      CREATE INDEX IF NOT EXISTS idx_partner_checkins_provider_date ON partner_checkins(provider, checkin_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_id ON payments(external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_expenses_due_date ON expenses(due_date);
      CREATE INDEX IF NOT EXISTS idx_commissions_staff ON commissions(staff_id);
      CREATE INDEX IF NOT EXISTS idx_body_assessments_member ON body_assessments(member_id);
      CREATE INDEX IF NOT EXISTS idx_class_bookings_class_date ON class_bookings(class_id, booking_date);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

      CREATE TABLE IF NOT EXISTS member_debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        origin_payment_id INTEGER REFERENCES payments(id),
        plan_id INTEGER REFERENCES plans(id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        paid_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        due_date TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_member_debts_member_status ON member_debts(member_id, status);
      CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
      CREATE INDEX IF NOT EXISTS idx_membership_charges_payment_due ON membership_charges(payment_id, due);
      CREATE INDEX IF NOT EXISTS idx_members_role_status ON members(access_role, status);
      CREATE INDEX IF NOT EXISTS idx_class_enrollments_member ON class_enrollments(member_id);

      CREATE TABLE IF NOT EXISTS member_freezes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        started_at TEXT NOT NULL,
        planned_until TEXT,
        unfrozen_at TEXT,
        extended_days INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_member_freezes_member_started ON member_freezes(member_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_status_created ON whatsapp_logs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_class_bookings_member ON class_bookings(member_id);
      CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id);
      CREATE INDEX IF NOT EXISTS idx_plan_enrollments_ends_on ON plan_enrollments(ends_on);
      CREATE INDEX IF NOT EXISTS idx_payment_receipts_member ON payment_receipts(member_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_charges_member ON gateway_charges(member_id);
      CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
    `);

    this.ensureColumns('classes', {
      allow_new_enrollments: 'INTEGER NOT NULL DEFAULT 1',
      online_enrollment_mode: "TEXT NOT NULL DEFAULT 'auto'",
    });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS online_enrollment_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        document TEXT,
        birth_date TEXT,
        modality_id INTEGER REFERENCES modalities(id),
        modality_name TEXT,
        class_id INTEGER REFERENCES classes(id),
        plan_id INTEGER REFERENCES plans(id),
        child_age TEXT,
        preferred_schedule TEXT,
        notes TEXT,
        source TEXT NOT NULL DEFAULT 'site',
        status TEXT NOT NULL DEFAULT 'pending',
        member_id INTEGER REFERENCES members(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `);

    const classRulesApplied = this.get("SELECT value FROM settings WHERE key = 'class_rules_v1_applied'")?.value;
    if (!classRulesApplied) {
      this.db.run(`
        UPDATE classes
        SET allow_new_enrollments = 0
        WHERE lower(name) LIKE '%pilates%'
          AND (schedule LIKE '%18%' OR lower(name) LIKE '%18%')
      `);
      this.db.run(`
        UPDATE classes
        SET capacity = 15
        WHERE lower(name) LIKE '%hidro%'
          AND capacity > 15
      `);
      this.db.run(`
        UPDATE classes
        SET capacity = 6
        WHERE lower(name) LIKE '%nata%'
          AND lower(name) LIKE '%adult%'
          AND capacity > 6
      `);
      this.db.run(`
        UPDATE classes
        SET online_enrollment_mode = 'reception_only'
        WHERE (lower(name) LIKE '%nata%' OR lower(name) LIKE '%baby%')
          AND (lower(name) LIKE '%infantil%' OR lower(name) LIKE '%baby%' OR lower(name) LIKE '%crian%')
      `);
      this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('class_rules_v1_applied', '1')");
    }

    this.ensureColumns('plans', {
      allowed_start_time: 'TEXT',
      allowed_end_time: 'TEXT',
      weekly_limit: 'INTEGER',
    });
    this.ensureColumns('app_users', {
      token_version: 'INTEGER NOT NULL DEFAULT 1',
    });
    this.ensureColumns('members', {
      birth_date: 'TEXT',
      sex: 'TEXT',
      manual_access: 'INTEGER NOT NULL DEFAULT 0',
      access_role: "TEXT NOT NULL DEFAULT 'student'",
      address: 'TEXT',
      emergency_contact: 'TEXT',
      notes: 'TEXT',
      modality_id: 'INTEGER',
      profile_photo: 'TEXT',
      portal_password_hash: 'TEXT',
      portal_invite_hash: 'TEXT',
      portal_invite_expires_at: 'INTEGER',
      portal_token_version: 'INTEGER NOT NULL DEFAULT 1',
      credit_cents: 'INTEGER NOT NULL DEFAULT 0',
      partner_provider: 'TEXT',
      wellhub_id: 'TEXT',
      frozen_until: 'TEXT',
      frozen_started_at: 'TEXT',
      frozen_reason: 'TEXT',
      parq_signed_at: 'TEXT',
      contract_signed_at: 'TEXT',
      contract_signature: 'TEXT',
      is_visitor: 'INTEGER NOT NULL DEFAULT 0',
      visitor_expires_at: 'TEXT',
      whatsapp_opt_out: 'INTEGER NOT NULL DEFAULT 0',
    });
    this.ensureColumns('payments', {
      staff_id: 'INTEGER',
      enrollment_ends_on: 'TEXT',
    });
    this.ensureColumns('gateway_charges', {
      membership_charge_id: 'INTEGER REFERENCES membership_charges(id)',
      checkout_ref: 'TEXT',
    });
    this.ensureColumns('point_orders', { membership_charge_id: 'INTEGER REFERENCES membership_charges(id)' });
    this.ensureColumns('access_logs', {
      edge_event_id: 'TEXT',
      edge_synced: 'INTEGER NOT NULL DEFAULT 0',
    });
    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_access_logs_edge_event_id ON access_logs(edge_event_id)');

    // Mantém os importadores e chamadas legadas de plano em compatibilidade.
    this.db.run(`
      INSERT OR IGNORE INTO plan_enrollments (member_id, plan_id, ends_on)
      SELECT id, plan_id, valid_until FROM members WHERE plan_id IS NOT NULL OR valid_until IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS members_plan_insert AFTER INSERT ON members
      WHEN NEW.plan_id IS NOT NULL OR NEW.valid_until IS NOT NULL
      BEGIN
        INSERT INTO plan_enrollments (member_id, plan_id, ends_on)
        VALUES (NEW.id, NEW.plan_id, NEW.valid_until);
      END;
      CREATE TRIGGER IF NOT EXISTS members_plan_update AFTER UPDATE OF plan_id, valid_until ON members
      WHEN NEW.plan_id IS NOT OLD.plan_id OR NEW.valid_until IS NOT OLD.valid_until
      BEGIN
        INSERT INTO plan_enrollments (member_id, plan_id, ends_on)
        VALUES (NEW.id, NEW.plan_id, NEW.valid_until)
        ON CONFLICT (member_id) DO UPDATE SET plan_id = NEW.plan_id, ends_on = NEW.valid_until, starts_on = NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS members_plan_delete AFTER DELETE ON members
      BEGIN
        DELETE FROM plan_enrollments WHERE member_id = OLD.id;
      END;
    `);

    this.db.run(`INSERT OR IGNORE INTO member_modalities (member_id, modality_id)
      SELECT m.id, mo.id FROM members m JOIN modalities mo ON mo.id = m.modality_id
      UNION SELECT ce.member_id, c.modality_id FROM class_enrollments ce
        JOIN members m ON m.id = ce.member_id JOIN classes c ON c.id = ce.class_id
        JOIN modalities mo ON mo.id = c.modality_id`);

    this.save();
  }

  seedDefaults() {
    const defaults = {
      gym_name: 'Academia Oxigênio',
      gym_phone: '',
      controlid_ip: process.env.CONTROLID_IP || '192.168.0.129',
      controlid_port: process.env.CONTROLID_PORT || '81',
      controlid_user: process.env.CONTROLID_USER || 'admin',
      controlid_password: process.env.CONTROLID_PASSWORD || 'admin',
      controlid_action_mode: process.env.CONTROLID_ACTION_MODE || 'sec_box',
      controlid_secbox_id: process.env.CONTROLID_SECBOX_ID || '65793',
      controlid_group_id: process.env.CONTROLID_GROUP_ID || '1',
      controlid_mock_mode: process.env.CONTROLID_MOCK_MODE || 'false',
      toletus_ip: process.env.TOLETUS_IP || '192.168.100.242',
      toletus_port: process.env.TOLETUS_PORT || '7878',
      toletus_enabled: process.env.TOLETUS_ENABLED || 'true',
      turnstile_release_seconds: '5',
      turnstile_direction: 'entry',
      turnstile_free_side: 'none',
      tolerance_days: process.env.TOLERANCE_DAYS || '3',
      whatsapp_enabled: '0',
      whatsapp_notify_payment: '1',
      whatsapp_notify_due: '1',
      whatsapp_due_days_before: '1',
      whatsapp_notify_inactive: '1',
      whatsapp_inactive_days: '10',
      whatsapp_notify_welcome: '1',
      whatsapp_notify_workout_review: '1',
      whatsapp_notify_winback: '1',
      whatsapp_notify_class_reminder: '1',
      whatsapp_notify_waitlist: '1',
      whatsapp_daily_limit: '40',
      whatsapp_min_delay_sec: '15',
      whatsapp_window_start: '08:00',
      whatsapp_window_end: '20:00',
      whatsapp_tpl_payment:
        '{saudacao} {primeiro_nome}! Pagamento de {valor} ({plano}) confirmado na {academia}. Acesso liberado até {vencimento}. Bom treino!',
      whatsapp_tpl_due:
        '{saudacao} {primeiro_nome}! Passando para lembrar que seu plano {plano} na {academia} vence em {vencimento}. Qualquer dúvida estamos à disposição!',
      whatsapp_tpl_inactive:
        '{saudacao} {primeiro_nome}! Sentimos sua falta na {academia} — já faz {dias_sem_vir} dias desde seu último treino. Bora retomar o ritmo hoje?',
      gemini_api_key: process.env.GEMINI_API_KEY || '',
      gemini_model: 'gemini-3.8-flash',
      pix_recipient_name: '',
      pix_recipient_key: '',
      whatsapp_receipt_enabled: '1',
      whatsapp_receipt_auto_approve: '0',
      mp_access_token: process.env.MP_ACCESS_TOKEN || '',
      mp_point_access_token: process.env.MP_POINT_ACCESS_TOKEN || '',
      mp_point_terminal_id: process.env.MP_POINT_TERMINAL_ID || '',
      wellhub_enabled: '1',
      wellhub_require_checkin: '0',
      wellhub_api_key: '',
      wellhub_gym_id: '',
      wellhub_webhook_secret: '',
      totalpass_enabled: '1',
      totalpass_require_checkin: '0',
      totalpass_api_token: '',
      totalpass_gym_id: '',
      totalpass_webhook_secret: '',
      auth_enabled: '0',
      auth_username: 'admin',
      auth_password_hash: '',
      auth_session_secret: '',
      antipassback_minutes: '0',
      max_capacity: '0',
      auto_collection_enabled: '0',
      backup_last_at: '',
    };

    for (const [key, value] of Object.entries(defaults)) {
      const existing = this.get('SELECT value FROM settings WHERE key = ?', [key]);
      if (!existing) {
        this.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
      }
    }
    this.db.run(`UPDATE settings SET value = 'gemini-3.8-flash' WHERE key = 'gemini_model' AND value = 'gemini-2.5-flash'`);

    if ((this.get('SELECT COUNT(*) AS c FROM plans')?.c ?? 0) === 0) {
      this.db.run(
        'INSERT INTO plans (name, duration_days, price_cents) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
        ['Diária', 1, 2500, 'Mensal', 30, 12000, 'Trimestral', 90, 32000],
      );
    }

    if ((this.get('SELECT COUNT(*) AS c FROM payment_methods')?.c ?? 0) === 0) {
      this.db.run(
        'INSERT INTO payment_methods (code, name) VALUES (?, ?), (?, ?), (?, ?), (?, ?)',
        ['pix', 'Pix', 'cash', 'Dinheiro', 'credit', 'Cartão de Crédito', 'debit', 'Cartão de Débito'],
      );
    }

    if ((this.get('SELECT COUNT(*) AS c FROM staff')?.c ?? 0) === 0) {
      this.db.run('INSERT INTO staff (name, role) VALUES (?, ?)', ['Recepção Padrão', 'Atendente']);
    }

    if ((this.get('SELECT COUNT(*) AS c FROM modalities')?.c ?? 0) === 0) {
      this.db.run(
        'INSERT INTO modalities (name, description) VALUES (?, ?), (?, ?), (?, ?)',
        ['Musculação', 'Treino livre de musculação', 'Funcional', 'Treino funcional em grupo', 'Spinning', 'Aulas de bike indoor'],
      );
    }

    const s = this.getSettings();
    if ((this.get('SELECT COUNT(*) AS c FROM turnstiles')?.c ?? 0) === 0) {
      this.db.run(
        `INSERT INTO turnstiles (name, driver, ip, port, release_seconds, default_direction, free_side, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          'Catraca Principal',
          s.toletus_enabled === 'false' ? 'controlid' : 'toletus',
          s.toletus_ip || '192.168.100.242',
          Number(s.toletus_port || 7878),
          Math.max(1, Number(s.turnstile_release_seconds || 5)),
          s.turnstile_direction || 'entry',
          s.turnstile_free_side || 'none',
        ],
      );
    }

    if ((this.get('SELECT COUNT(*) AS c FROM readers')?.c ?? 0) === 0) {
      const mainTurnstile = this.get('SELECT id FROM turnstiles ORDER BY id ASC LIMIT 1');
      this.db.run(
        `INSERT INTO readers (name, brand, ip, port, username, password, action_mode, secbox_id, group_id, direction, turnstile_id, active)
         VALUES (?, 'controlid', ?, ?, ?, ?, ?, ?, ?, 'entry', ?, 1)`,
        [
          'Leitor Principal',
          s.controlid_ip || '192.168.0.129',
          Number(s.controlid_port || 81),
          s.controlid_user || 'admin',
          s.controlid_password || 'admin',
          s.controlid_action_mode || 'sec_box',
          Number(s.controlid_secbox_id || 65793),
          Number(s.controlid_group_id || 1),
          mainTurnstile?.id || null,
        ],
      );
    }

    if ((this.get('SELECT COUNT(*) AS c FROM products')?.c ?? 0) === 0) {
      this.db.run(
        'INSERT INTO products (name, category, price_cents, stock) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        ['Água Mineral 500ml', 'Bebidas', 400, 30, 'Whey Dose', 'Suplementos', 1200, 20],
      );
    }

    this.save();
  }

  getSettings() {
    const rows = this.all('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  updateSettings(entries) {
    return this.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined || value === null) continue;
        this.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [key, String(value)],
        );
      }
      return this.getSettings();
    });
  }
}
