import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
import { FinanceService } from '../src/services/financeService.js';
import { BackupService } from '../src/services/backupService.js';
import { AuditService } from '../src/services/auditService.js';
import { AuthService, requireRole } from '../src/services/authService.js';
import { GymService } from '../src/services/gymService.js';

function localDateIso(offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test('FinanceService: despesas, DRE mensal, comissões e cobrança automática via WhatsApp', () => {
  return (async () => {
    const store = await DatabaseStore.create(null);
    const finance = new FinanceService(store);

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dueDate = `${month}-10`;

    // Despesas: criar, listar, pagar e excluir
    const exp1 = finance.createExpense({
      description: 'Aluguel',
      category: 'infraestrutura',
      amount_cents: 250000,
      due_date: dueDate,
      notes: 'Vencimento dia 10',
    });
    const exp2 = finance.createExpense({
      description: 'Energia Elétrica',
      category: 'utilidades',
      amount_cents: 65000,
      due_date: dueDate,
    });
    const exp3 = finance.createExpense({
      description: 'Despesa Temporária',
      category: 'geral',
      amount_cents: 1000,
      due_date: dueDate,
    });

    assert.equal(finance.listExpenses({ month }).length, 3);
    const paidExp1 = finance.markExpensePaid(exp1.id, 'pix');
    assert.equal(paidExp1.status, 'paid');
    assert.equal(paidExp1.payment_method, 'pix');
    assert.ok(paidExp1.paid_at);

    assert.equal(finance.listExpenses({ status: 'paid', month }).length, 1);
    assert.equal(finance.listExpenses({ status: 'pending', month }).length, 2);

    const delRes = finance.deleteExpense(exp3.id);
    assert.equal(delRes.deleted, true);
    assert.equal(finance.listExpenses({ month }).length, 2);

    // Receitas para o DRE: pagamento + pos_sales opcional
    const memberRes = store.run(
      `INSERT INTO members (name, phone, status, valid_until) VALUES (?, ?, 'active', ?)`,
      ['Ana Clara', '11999990001', localDateIso(2, now)],
    );
    const plan = store.get('SELECT id FROM plans LIMIT 1');
    store.run(
      `INSERT INTO payments (member_id, plan_id, amount_cents, method, status, paid_at)
       VALUES (?, ?, 400000, 'pix', 'paid', ?)`,
      [memberRes.lastInsertRowid, plan.id, `${month}-05 10:00:00`],
    );

    const dre = finance.getDreSummary(month);
    assert.equal(dre.month, month);
    assert.equal(dre.revenues.payments_cents, 400000);
    assert.equal(dre.revenues.pos_sales_cents, 0);
    assert.equal(dre.revenues.total_cents, 400000);
    assert.equal(dre.expenses.paid_cents, 250000);
    assert.equal(dre.expenses.pending_cents, 65000);
    assert.equal(dre.expenses.total_cents, 315000);
    assert.equal(dre.expenses.by_category.length, 2);
    assert.equal(dre.net_profit_cents, 150000);
    assert.equal(dre.projected_net_profit_cents, 85000);

    // Comissões
    const staffRes = store.run(`INSERT INTO staff (name, role) VALUES ('Carlos Personal', 'Professor')`);
    const com = finance.createCommission({
      staff_id: staffRes.lastInsertRowid,
      staff_name: 'Carlos Personal',
      source_type: 'enrollment',
      source_id: 99,
      description: 'Matrícula plano trimestral',
      amount_cents: 5000,
    });
    assert.equal(com.status, 'pending');
    assert.equal(finance.listCommissions({ staffId: staffRes.lastInsertRowid, status: 'pending' }).length, 1);

    const paidCom = finance.markCommissionPaid(com.id);
    assert.equal(paidCom.status, 'paid');
    assert.ok(paidCom.paid_at);

    // Cobrança automática: 1 aluno vencendo em +2 dias, 1 atrasado há -2 dias, 1 fora da janela (+15 dias)
    store.run(
      `INSERT INTO members (name, phone, status, valid_until) VALUES (?, ?, 'overdue', ?)`,
      ['Bruno Silva', '11999990002', localDateIso(-2, now)],
    );
    store.run(
      `INSERT INTO members (name, phone, status, valid_until) VALUES (?, ?, 'active', ?)`,
      ['Carla Dias', '11999990003', localDateIso(15, now)],
    );

    const enqueued = [];
    const seenKeys = new Set();
    const fakeWhatsapp = {
      enqueueMessage(payload) {
        const key = `${payload.memberId}:${payload.kind}:${payload.refKey}`;
        if (seenKeys.has(key)) return null;
        seenKeys.add(key);
        enqueued.push(payload);
        return { id: enqueued.length, ...payload };
      },
    };

    const run1 = finance.runAutoCollection(fakeWhatsapp, now);
    assert.equal(run1.total, 2);
    assert.equal(run1.queued, 2);
    assert.equal(run1.skipped, 0);

    // Deduplicação no mesmo dia
    const run2 = finance.runAutoCollection(fakeWhatsapp, now);
    assert.equal(run2.total, 2);
    assert.equal(run2.queued, 0);
    assert.equal(run2.skipped, 2);
  })();
});

test('BackupService: cria, lista, resolve caminho e bloqueia path traversal', async (t) => {
  const store = await DatabaseStore.create(null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-backup-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const backup = new BackupService(store, tmpDir);
  assert.deepEqual(backup.listBackups(), []);

  const created = backup.createBackup();
  assert.ok(created.filename.endsWith('.sqlite'));
  assert.ok(created.size_bytes > 0);
  assert.ok(fs.existsSync(created.path));

  const lastAt = store.get(`SELECT value FROM settings WHERE key = 'backup_last_at'`)?.value;
  assert.equal(lastAt, created.created_at);

  const listed = backup.listBackups();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].filename, created.filename);

  const resolved = backup.getBackupPath(created.filename);
  assert.equal(resolved, path.resolve(tmpDir, created.filename));

  assert.throws(() => backup.getBackupPath('../secret.sqlite'), /inválido/i);
  assert.throws(() => backup.getBackupPath('..\\secret.sqlite'), /inválido/i);
  assert.throws(() => backup.getBackupPath('subdir/file.sqlite'), /inválido/i);
  assert.throws(() => backup.getBackupPath('inexistente.sqlite'), /não encontrado/i);
});

test('AuditService + AuthService RBAC: usuários, autenticação e requireRole', async () => {
  const store = await DatabaseStore.create(null);
  const audit = new AuditService(store);
  const auth = new AuthService(store);

  auth.configure({ enabled: true, username: 'admin', password: 'admin-password-123' });

  const reception = auth.createUser({
    username: 'recepcao1',
    password: 'reception-password-123',
    role: 'reception',
  });
  const instructor = auth.createUser({
    username: 'instrutor1',
    password: 'instructor-password-123',
    role: 'instructor',
  });
  assert.equal(reception.role, 'reception');
  assert.equal(instructor.role, 'instructor');

  const authedRec = auth.authenticateUser('recepcao1', 'reception-password-123');
  assert.equal(authedRec?.username, 'recepcao1');
  assert.equal(authedRec?.role, 'reception');

  const authedAdmin = auth.authenticateUser('admin', 'admin-password-123');
  assert.equal(authedAdmin?.username, 'admin');
  assert.equal(authedAdmin?.role, 'admin');
  assert.equal(auth.authenticateUser('recepcao1', 'senha-errada'), null);

  const runRoleMw = (mw, role) =>
    new Promise((resolve) => {
      const req = { authUser: 'u', authRole: role, auth: { username: 'u', role } };
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(obj) {
          this.body = obj;
          resolve({ nextCalled: false, statusCode: this.statusCode, body: obj });
        },
      };
      mw(req, res, () => resolve({ nextCalled: true, statusCode: 200 }));
    });

  const adminOnlyMw = requireRole('admin');
  const recBlocked = await runRoleMw(adminOnlyMw, 'reception');
  assert.equal(recBlocked.nextCalled, false);
  assert.equal(recBlocked.statusCode, 403);

  const adminAllowed = await runRoleMw(adminOnlyMw, 'admin');
  assert.equal(adminAllowed.nextCalled, true);
  assert.equal(adminAllowed.statusCode, 200);

  // AuditService
  const logEntry = audit.log({
    actorUser: 'admin',
    actorRole: 'admin',
    action: 'user.create',
    entity: 'app_users',
    entityId: String(reception.id),
    details: { role: 'reception' },
  });
  assert.equal(logEntry.action, 'user.create');
  const logs = audit.list({ entity: 'app_users', actorUser: 'admin' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].entity_id, String(reception.id));
});

test('GymService: avaliações físicas, reservas com lista de espera e gamificação', async () => {
  const store = await DatabaseStore.create(null);
  const gym = new GymService(store);

  const m1 = store.run(`INSERT INTO members (name, status) VALUES ('Aluno Um', 'active')`).lastInsertRowid;
  const m2 = store.run(`INSERT INTO members (name, status) VALUES ('Aluno Dois', 'active')`).lastInsertRowid;

  // Avaliações físicas
  const a1 = gym.createAssessment(m1, {
    assessed_at: '2026-11-10',
    weight_kg: 78.5,
    height_cm: 175,
    body_fat_pct: 16.2,
    assessed_by: 'Prof. João',
  });
  assert.equal(a1.weight_kg, 78.5);
  assert.equal(gym.listAssessments(m1).length, 1);
  const delA1 = gym.deleteAssessment(a1.id);
  assert.equal(delA1.deleted, true);
  assert.equal(gym.listAssessments(m1).length, 0);

  // Reservas e lista de espera (capacidade = 1)
  const clsId = store.run(
    `INSERT INTO classes (name, schedule, capacity) VALUES ('Spinning', '19:00', 1)`,
  ).lastInsertRowid;

  const b1 = gym.bookClass({ classId: clsId, memberId: m1, bookingDate: '2026-11-20' });
  assert.equal(b1.status, 'confirmed');

  const b2 = gym.bookClass({ classId: clsId, memberId: m2, bookingDate: '2026-11-20' });
  assert.equal(b2.status, 'waitlist');

  const cancelRes = gym.cancelClassBooking(b1.id, m1);
  assert.equal(cancelRes.canceled, true);
  assert.equal(cancelRes.promoted?.id, b2.id);
  assert.equal(cancelRes.promoted?.status, 'confirmed');

  // Gamificação
  const nowLocal = store.get(`SELECT datetime('now', 'localtime') AS ts`).ts;
  store.run(
    `INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'authorized', ?)`,
    [m1, nowLocal],
  );
  const gamification = gym.getMemberGamification(m1);
  assert.equal(gamification.totalVisits, 1);
  assert.equal(gamification.monthVisits, 1);
  assert.ok(gamification.weeklyStreak >= 1);
  assert.ok(gamification.badges.some((b) => b.key === 'first_visit'));
});

test('BackupService: inclui pasta photos no backup sob demanda e limpa .photos na rotação', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-bkp-photos-'));
  try {
    const dbPath = path.join(tmpDir, 'oxigenio.sqlite');
    const photosDir = path.join(tmpDir, 'photos');
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(photosDir, { recursive: true });
    fs.writeFileSync(path.join(photosDir, '1-1.jpg'), Buffer.from('photo-bytes'));

    const store = await DatabaseStore.create(dbPath);
    const service = new BackupService(store, backupDir);

    const b1 = service.createBackup({ maxKeep: 1 });
    assert.equal(b1.photos_included, true);
    assert.equal(b1.size, b1.size_bytes);
    assert.ok(fs.existsSync(`${b1.path}.photos`));
    assert.ok(fs.existsSync(path.join(`${b1.path}.photos`, '1-1.jpg')));

    await new Promise((r) => setTimeout(r, 15));
    const b2 = service.createBackup({ maxKeep: 1 });
    assert.equal(b2.photos_included, true);
    assert.ok(fs.existsSync(`${b2.path}.photos`));
    // Rotação deve remover tanto o .sqlite antigo quanto sua pasta .photos correspondente
    assert.equal(fs.existsSync(b1.path), false);
    assert.equal(fs.existsSync(`${b1.path}.photos`), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GymService.getCashSessionDetails retorna entradas, saidas e movimentacoes de turno encerrado', async () => {
  const store = await DatabaseStore.create(null);
  const gym = new GymService(store);
  const opened = gym.openCashSession({ opening_cents: 5000, notes: 'Manha' });
  gym.addManualCashMovement({ type: 'in', amount_cents: 3000, method: 'cash', description: 'Troco' });
  gym.addManualCashMovement({ type: 'out', amount_cents: 1500, method: 'cash', description: 'Agua' });
  gym.recordCashMovementIfOpen({ type: 'payment', amount_cents: 12000, method: 'pix', description: 'Mensalidade' });
  const closed = gym.closeCashSession({ closing_cents: 6500, notes: 'Conferido ok' });

  const detail = gym.getCashSessionDetails(closed.id);
  assert.equal(detail.status, 'closed');
  assert.equal(detail.opening_cents, 5000);
  assert.equal(detail.total_in_cents, 15000);
  assert.equal(detail.total_out_cents, 1500);
  assert.equal(detail.expected_cents, 6500);
  assert.equal(detail.movements.length, 3);
  assert.throws(() => gym.getCashSessionDetails(999999), /não encontrado/);
});
