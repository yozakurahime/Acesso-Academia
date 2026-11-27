import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { ToletusClient } from '../src/services/toletusClient.js';
import { AccessService } from '../src/services/accessService.js';
import { GymService } from '../src/services/gymService.js';
import { WhatsappService } from '../src/services/whatsappService.js';

let cpfSeq = 200000001;
function nextCpf() {
  const base = String(cpfSeq++).padStart(9, '0');
  const calc = (str) => {
    let sum = 0;
    for (let i = 0; i < str.length; i += 1) sum += Number(str[i]) * (str.length + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };
  const d1 = calc(base);
  const d2 = calc(base + d1);
  return `${base}${d1}${d2}`;
}

function createTestEnv() {
  return DatabaseStore.create(null).then((store) => {
    store.updateSettings({ controlid_mock_mode: 'true', tolerance_days: '2' });
    const controlId = new ControlIdClient(() => store.getSettings());
    const toletus = new ToletusClient(() => store.getSettings());
    const service = new AccessService(store, controlId, toletus);
    return { store, controlId, toletus, service };
  });
}

test('fluxo completo: cadastro, pagamento libera acesso e vencimento bloqueia', async () => {
  const { store, service } = await createTestEnv();

  const plans = service.listPlans();
  assert.ok(plans.length >= 3, 'Deve semear planos padrao');
  const mensal = plans.find((p) => p.name === 'Mensal');

  const member = await service.createMember({
    name: 'Maria Silva',
    document: nextCpf(),
    phone: '11999999999',
    plan_id: mensal.id,
  });
  assert.equal(member.status, 'pending');
  assert.equal(member.face_registered, 0);

  // Cadastro facial
  const fakeJpegBase64 = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  const withFace = await service.registerFace(member.id, fakeJpegBase64);
  assert.equal(withFace.face_registered, 1);

  // Pagamento libera acesso
  const payRes = await service.recordPayment({
    member_id: member.id,
    plan_id: mensal.id,
    method: 'pix',
  });
  assert.equal(payRes.member.status, 'active');
  assert.ok(payRes.member.valid_until, 'Deve definir valid_until');
  assert.equal(payRes.sync.synced, true);

  // Simular vencimento alem dos 2 dias de tolerancia
  store.run("UPDATE members SET valid_until = '2020-01-01' WHERE id = ?", [member.id]);
  const blocked = await service.checkExpiredMembers();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, member.id);

  const afterExpire = service.getMember(member.id);
  assert.equal(afterExpire.status, 'blocked');
});

test('dashboard retorna totais de clientes e receita do dia', async () => {
  const { service } = await createTestEnv();
  const plans = service.listPlans();
  const diaria = plans.find((p) => p.name === 'Diária');

  const m1 = await service.createMember({ name: 'Joao Teste', document: nextCpf(), plan_id: diaria.id });
  await service.recordPayment({ member_id: m1.id, plan_id: diaria.id, method: 'cash' });
  await service.createMember({ name: 'Pessoa da equipe', document: nextCpf(), access_role: 'staff' });
  await service.handleFaceIdentified(m1.id);

  const summary = service.getDashboardSummary();
  assert.equal(summary.activeMembers, 1);
  assert.equal(summary.teamMembers, 1);
  assert.equal(summary.allowedToday, 1);
  assert.equal(summary.deniedToday, 0);
  assert.equal(summary.revenueTodayCents, diaria.price_cents);
});

test('FaceID exige matrícula vigente e calcula a data final pelo plano', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans()[0];
  const member = await service.createMember({ name: 'Aluno exemplo', document: nextCpf(), plan_id: plan.id });
  const today = store.get("SELECT date('now', 'localtime') AS today").today;
  assert.equal((await service.handleFaceIdentified(member.id)).message, 'Matrícula sem vigência');

  await service.savePlanEnrollment(member.id, { plan_id: plan.id, starts_on: '2020-03-10' });
  assert.equal((await service.handleFaceIdentified(member.id)).message, 'Matrícula vencida');
  await assert.rejects(service.setMemberStatus(member.id, 'active', { manualAccess: true }), /Matrícula vencida/);

  const active = await service.savePlanEnrollment(member.id, { plan_id: plan.id, starts_on: today });
  assert.equal(active.enrollment.ends_on, today);
  assert.equal((await service.handleFaceIdentified(member.id)).allowed, true);
  await service.setMemberStatus(member.id, 'blocked');
  assert.equal((await service.handleFaceIdentified(member.id)).allowed, false);
  await service.setMemberStatus(member.id, 'active');
  assert.equal((await service.handleFaceIdentified(member.id)).allowed, true);
  const renewal = await service.recordPayment({ member_id: member.id, plan_id: plan.id });
  assert.equal(renewal.member.valid_until, store.get("SELECT date('now', 'localtime', '+1 day') AS tomorrow").tomorrow);
});

test('resumo de alunos mantém modalidade e plano sem carregar dados do perfil', async () => {
  const { store, service } = await createTestEnv();
  const modality = store.run("INSERT INTO modalities (name) VALUES ('Pilates')");
  const plan = service.listPlans()[0];
  const member = await service.createMember({
    name: 'Aluna Exemplo',
    document: nextCpf(),
    email: 'aluna@example.test',
    address: 'Endereço de teste',
    plan_id: plan.id,
    modality_id: modality.lastInsertRowid,
  });
  const [summary] = service.listMembers('Exemplo', { summary: true });
  assert.equal(summary.id, member.id);
  assert.equal(summary.modality_name, 'Pilates');
  assert.equal(summary.plan_name, plan.name);
  assert.equal('email' in summary, false);
  assert.equal('address' in summary, false);
  assert.equal(service.listMembers('Exemplo')[0].email, 'aluna@example.test');
});

test('equipe usa FaceID sem matrícula e volta à regra do plano ao virar aluno', async () => {
  const { service, controlId, store } = await createTestEnv();
  const permissions = [];
  controlId.syncMember = async (member, allowed) => permissions.push([member.id, allowed]);
  for (const access_role of ['user', 'instructor', 'staff']) {
    const member = await service.createMember({ name: `Equipe exemplo ${access_role}`, document: nextCpf(), access_role });
    assert.deepEqual(permissions.at(-1), [member.id, true]);
    assert.equal(service.getPlanEnrollment(member.id), null);
    assert.equal((await service.handleFaceIdentified(member.id)).allowed, true);
    assert.equal(service.getTurnstileDisplay().validUntil, undefined);
    store.run("UPDATE members SET valid_until = '2020-03-10' WHERE id = ?", [member.id]);
    assert.deepEqual(await service.checkExpiredMembers(), []);
    assert.equal((await service.handleFaceIdentified(member.id)).allowed, true);
    await service.setAccessRole(member.id, 'student');
    assert.deepEqual(permissions.at(-1), [member.id, false]);
    assert.equal((await service.handleFaceIdentified(member.id)).allowed, false);
  }
});

test('toletus monta pacote LiteNet2 de 20 bytes e Modo Online valida mensalidade', async () => {
  const { toletus, service } = await createTestEnv();

  const packet = toletus.buildPacket(0x0001, 'Maria');
  assert.equal(packet.length, 20);
  assert.equal(packet[0], 0x53);
  assert.equal(packet.readUInt16LE(1), 0x0001);
  assert.equal(packet.subarray(3, 8).toString('ascii'), 'MARIA');
  assert.equal(packet[19], 0xc3);

  const plans = service.listPlans();
  const mensal = plans.find((p) => p.name === 'Mensal');
  const member = await service.createMember({ name: 'Carlos Lima', document: nextCpf(), plan_id: mensal.id });

  const denied = await service.handleFaceIdentified(member.controlid_user_id);
  assert.equal(denied.allowed, false);
  assert.equal(denied.event, 6);

  await service.recordPayment({ member_id: member.id, plan_id: mensal.id, method: 'pix' });
  const allowed = await service.handleFaceIdentified(member.controlid_user_id);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.event, 7);
});

test('getMemberPhoto busca foto no Control iD quando aluno tem face vinculada', async () => {
  const store = await DatabaseStore.create(null);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const controlId = {
    async syncMember(m) {
      return { controlIdUserId: m.id, allowed: false };
    },
    async getUserImage(uid) {
      return uid === 1 ? fakeJpeg : null;
    },
  };
  const service = new AccessService(store, controlId, null);
  const member = await service.createMember({ name: 'Foto Teste', document: nextCpf() });
  store.run('UPDATE members SET face_registered = 1 WHERE id = ?', [member.id]);

  const photo = await service.getMemberPhoto(member.id);
  assert.deepEqual(photo, fakeJpeg);
});

test('cadastros seguem sequências independentes e preservam IDs usados', async () => {
  const { store, service } = await createTestEnv();
  const gym = new GymService(store);
  const firstMember = await service.createMember({ name: 'Aluno anterior', document: nextCpf() });
  const firstInstructor = gym.createInstructor({ name: 'Professor anterior' });
  const firstStaff = gym.createStaff({ name: 'Funcionário anterior' });
  store.run('DELETE FROM members WHERE id = ?', [firstMember.id]);
  store.run('DELETE FROM instructors WHERE id = ?', [firstInstructor.id]);
  store.run('DELETE FROM staff WHERE id = ?', [firstStaff.id]);

  assert.equal((await service.createMember({ name: 'Aluno novo', document: nextCpf() })).id, firstMember.id + 1);
  assert.equal(gym.createInstructor({ name: 'Professor novo' }).id, firstInstructor.id + 1);
  assert.equal(gym.createStaff({ name: 'Funcionário novo' }).id, firstStaff.id + 1);
});

test('tela da catraca mostra dados mínimos da identificação e expira o resultado', async () => {
  const { store, service } = await createTestEnv();
  store.run("INSERT INTO members (id, name, controlid_user_id) VALUES (10, 'Cadastro diferente', 90)");
  store.run("INSERT INTO members (name, controlid_user_id, plan_id, status, valid_until) VALUES ('Carlos Lima', 10, 1, 'active', '2099-06-07')");
  assert.equal(service.getTurnstileDisplay(), null);

  const allowed = await service.handleFaceIdentified(10);
  assert.equal(allowed.member.name, 'Carlos Lima');
  const { remainingMs, ...display } = service.getTurnstileDisplay();
  assert.ok(remainingMs > 0 && remainingMs <= 8000);
  assert.deepEqual(display, {
    id: 1, outcome: 'allowed', firstName: 'Carlos', progress: { visits: 1, goal: 3 },
  });
  assert.throws(() => service.previewTurnstileDisplay('denied'), { statusCode: 409 });

  await service.handleFaceIdentified(90);
  const { remainingMs: deniedMs, ...denied } = service.getTurnstileDisplay();
  assert.ok(deniedMs > 0);
  assert.deepEqual(denied, { id: 2, outcome: 'denied', reason: 'Matrícula sem vigência' });
  await service.handleFaceIdentified(0);
  assert.equal(service.getTurnstileDisplay().outcome, 'unrecognized');
  service.turnstileDisplay.expiresAt = Date.now();
  assert.equal(service.getTurnstileDisplay(), null);
  const count = store.get('SELECT COUNT(*) AS count FROM access_logs').count;
  service.previewTurnstileDisplay('denied');
  assert.equal(service.getTurnstileDisplay().preview, true);
  assert.equal(service.getTurnstileDisplay().reason, 'Matrícula vencida');
  assert.equal(store.get('SELECT COUNT(*) AS count FROM access_logs').count, count);
  await service.handleFaceIdentified(10);
  assert.equal(service.getTurnstileDisplay().outcome, 'allowed');
  assert.equal(service.getTurnstileDisplay().preview, undefined);
  assert.equal(service.getTurnstileDisplay().progress, undefined);
});

test('divergência do leitor bloqueia a entrada e o vínculo confirmado preserva o ID facial', async () => {
  const { service, controlId } = await createTestEnv();
  const wrong = await service.createMember({ name: 'Outra Pessoa', document: nextCpf(), access_role: 'staff' });
  const owner = await service.createMember({ name: 'José da Silva', document: nextCpf(), access_role: 'staff' });
  controlId.getConfig = () => ({ mockMode: false });
  controlId.getDeviceUser = async (id) => id === wrong.id ? { id, name: 'JOSE DA SILVA', registration: String(id) } : null;
  const rejected = await service.handleFaceIdentified(wrong.id);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.member, undefined);
  const reader = await service.inspectDeviceLink(wrong.id);
  await assert.rejects(service.relinkDevice(owner.id, {
    device_id: reader.id, expected_name: reader.name, previous_ids: [],
  }), /O vínculo mudou/);
  await service.relinkDevice(owner.id, {
    device_id: reader.id, expected_name: reader.name, previous_ids: [wrong.id],
  });
  assert.equal(service.getMember(wrong.id).controlid_user_id, null);
  assert.equal((await service.handleFaceIdentified(wrong.id)).member.id, owner.id);
});

test('tolerance_days permite acesso dentro da carencia e bloqueia apos o limite', async () => {
  const { store, service } = await createTestEnv();
  store.updateSettings({ tolerance_days: '3' });
  const plan = service.listPlans()[0];
  const m = await service.createMember({ name: 'Aluno Carencia', document: nextCpf(), plan_id: plan.id });
  store.run("UPDATE members SET status = 'active' WHERE id = ?", [m.id]);

  const d1 = new Date();
  d1.setDate(d1.getDate() - 2);
  const twoDaysAgo = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')}`;
  store.run("UPDATE plan_enrollments SET starts_on = '2020-01-01', ends_on = ? WHERE member_id = ?", [twoDaysAgo, m.id]);
  assert.equal(service.getAccessDenial(service.getMember(m.id)), null);

  const d2 = new Date();
  d2.setDate(d2.getDate() - 5);
  const fiveDaysAgo = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
  store.run('UPDATE plan_enrollments SET ends_on = ? WHERE member_id = ?', [fiveDaysAgo, m.id]);
  assert.equal(service.getAccessDenial(service.getMember(m.id)), 'Matrícula vencida');
});

test('ControlIdClient.ensureSession compartilha login concorrente', async () => {
  const { controlId } = await createTestEnv();
  let loginCalls = 0;
  controlId.requestJson = async (endpoint) => {
    if (endpoint === '/login.fcgi') {
      loginCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { session: 'tok-123' };
    }
    return {};
  };
  controlId.getConfig = () => ({ baseUrl: 'http://127.0.0.1:81', user: 'admin', password: '123', mockMode: false });

  const [s1, s2] = await Promise.all([controlId.ensureSession(), controlId.ensureSession()]);
  assert.equal(s1, 'tok-123');
  assert.equal(s2, 'tok-123');
  assert.equal(loginCalls, 1);
});

test('updatePlan e deletePlan atualizam, excluem plano livre e bloqueiam plano em uso', async () => {
  const { service } = await createTestEnv();
  const created = service.createPlan({ name: 'Pilates (Mensal)', duration_days: 30, price_cents: 12000 });
  const updated = service.updatePlan(created.id, { name: 'Pilates (Trimestral)', duration_days: 90, price_cents: 32000 });
  assert.equal(updated.name, 'Pilates (Trimestral)');
  assert.equal(updated.duration_days, 90);
  assert.equal(updated.price_cents, 32000);

  const member = await service.createMember({ name: 'Aluno Plano', document: nextCpf(), plan_id: created.id });
  assert.ok(member.id);
  assert.throws(() => service.deletePlan(created.id), /Plano em uso/);

  const unused = service.createPlan({ name: 'Plano Temporario', duration_days: 30, price_cents: 10000 });
  const delRes = service.deletePlan(unused.id);
  assert.deepEqual(delRes, { deleted: true, id: unused.id });
  assert.equal(service.listPlans().some((p) => p.id === unused.id), false);
});

test('removeOverdueClassEnrollments remove da turma apos 10 dias de tolerancia sem acessos recentes e enfileira aviso no WhatsApp', async () => {
  const { store, service } = await createTestEnv();
  store.updateSettings({ whatsapp_enabled: '1' });
  const gym = new GymService(store);
  const wa = new WhatsappService(store);
  const plan = service.listPlans()[0];
  const mod = gym.createModality({ name: 'Natação Teste' });
  const cls = gym.createClass({ name: 'Natação 18:00', modality_id: mod.id, schedule: 'Ter/Qui 18:00', capacity: 8 });

  const mWithinGrace = await service.createMember({ name: 'Dentro Tolerancia', document: nextCpf(), phone: '11999990001', plan_id: plan.id });
  const mRecentAccess = await service.createMember({ name: 'Com Acesso Recente', document: nextCpf(), phone: '11999990003', plan_id: plan.id });
  const mOverdue = await service.createMember({ name: 'Fora Tolerancia', document: nextCpf(), phone: '11999990002', plan_id: plan.id });

  store.run("UPDATE members SET status = 'active', valid_until = '2026-05-03' WHERE id = ?", [mWithinGrace.id]);
  store.run("UPDATE members SET status = 'active', valid_until = '2026-04-28' WHERE id = ?", [mRecentAccess.id]);
  store.run("UPDATE members SET status = 'active', valid_until = '2026-04-28' WHERE id = ?", [mOverdue.id]);
  store.run(
    "INSERT INTO access_logs (member_id, controlid_user_id, event_code, event_label, occurred_at) VALUES (?, ?, 7, 'Liberado', '2026-05-05 18:00:00')",
    [mRecentAccess.id, mRecentAccess.id],
  );
  gym.enrollMemberInClass(cls.id, mWithinGrace.id);
  gym.enrollMemberInClass(cls.id, mRecentAccess.id);
  gym.enrollMemberInClass(cls.id, mOverdue.id);

  // Referência: 2026-05-10 -> cutoff 2026-04-30; 2026-05-03 (7d, dentro), 2026-04-28 c/ acesso em 2026-05-05 (mantem), 2026-04-28 sem acesso (remove)
  const removed = service.removeOverdueClassEnrollments(10, new Date('2026-05-10T12:00:00'));
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, mOverdue.id);
  assert.equal(removed[0].removedClasses[0].name, 'Natação 18:00');

  assert.ok(store.get('SELECT 1 FROM class_enrollments WHERE member_id = ?', [mWithinGrace.id]));
  assert.ok(store.get('SELECT 1 FROM class_enrollments WHERE member_id = ?', [mRecentAccess.id]));
  assert.equal(store.get('SELECT 1 FROM class_enrollments WHERE member_id = ?', [mOverdue.id]), null);

  const msg = await wa.enqueueClassRemovalNotice({ member: removed[0], removedClasses: removed[0].removedClasses, graceDays: 10 });
  assert.ok(msg.id);
  assert.equal(msg.kind, 'class_removal');
  assert.match(msg.message, /10 dias de tolerância/);
  assert.match(msg.message, /Natação 18:00/);
});

test('adjustMemberCredit e recordPayment permitem guardar ou abater crédito no pagamento', async () => {
  const { service } = await createTestEnv();
  const mensal = service.listPlans().find((p) => p.name === 'Mensal');
  const member = await service.createMember({ name: 'Aluno Credito', document: nextCpf(), plan_id: mensal.id });

  // Adiciona R$ 40,00 de crédito
  const creditRes = service.adjustMemberCredit(member.id, { amount_cents: 4000, type: 'add', reason: 'Bônus' });
  assert.equal(creditRes.credit_cents, 4000);
  assert.equal(creditRes.logs.length, 1);

  // Pagamento SEM usar crédito: valor integral cobrado e crédito preservado
  const p1 = await service.recordPayment({
    member_id: member.id,
    plan_id: mensal.id,
    amount_cents: mensal.price_cents,
    method: 'pix',
    use_credit: false,
  });
  assert.equal(p1.payment.amount_cents, mensal.price_cents);
  assert.equal(p1.credit_used_cents, 0);
  assert.equal(p1.member.credit_cents, 4000);

  // Pagamento USANDO crédito: abate R$ 40,00 e zera saldo de crédito
  const p2 = await service.recordPayment({
    member_id: member.id,
    plan_id: mensal.id,
    amount_cents: mensal.price_cents,
    method: 'pix',
    use_credit: true,
  });
  assert.equal(p2.credit_used_cents, 4000);
  assert.equal(p2.payment.amount_cents, mensal.price_cents - 4000);
  assert.equal(p2.member.credit_cents, 0);
  assert.equal(service.listMemberCreditLogs(member.id).length, 2);
});

test('releaseTurnstile publica estado allowed na tela da catraca', async () => {
  const { store, service } = await createTestEnv();
  store.updateSettings({ toletus_enabled: 'false' });
  assert.equal(service.getTurnstileDisplay(), null);
  await service.releaseTurnstile('entry');
  const display = service.getTurnstileDisplay();
  assert.equal(display.outcome, 'allowed');
  assert.ok(display.remainingMs > 0);
});

test('recordPayment aceita pagamento dividido (ex: 50 dinheiro + 50 pix) e registra no caixa', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Plano 100', price_cents: 10000, duration_days: 30 });
  const member = await service.createMember({ name: 'Aluno Dividido', document: nextCpf(), plan_id: plan.id });
  const cash = store.run("INSERT INTO cash_sessions (staff_name, opening_cents, status) VALUES ('Recepcao', 0, 'open')");

  const res = await service.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    amount_cents: 10000,
    split_payments: [
      { method: 'cash', amount_cents: 5000 },
      { method: 'pix', amount_cents: 5000 },
    ],
  }, { requireOpenCash: true });

  assert.equal(res.payments.length, 2);
  assert.equal(res.payments[0].method, 'cash');
  assert.equal(res.payments[0].amount_cents, 5000);
  assert.equal(res.payments[1].method, 'pix');
  assert.equal(res.payments[1].amount_cents, 5000);
  assert.equal(res.member.status, 'active');

  const moves = store.all('SELECT * FROM cash_movements WHERE session_id = ? ORDER BY id ASC', [cash.lastInsertRowid]);
  assert.equal(moves.length, 2);
  assert.equal(moves[0].method, 'cash');
  assert.equal(moves[0].amount_cents, 5000);
  assert.equal(moves[1].method, 'pix');
  assert.equal(moves[1].amount_cents, 5000);
});

test('recordPayment permite pagar parte e gerar debito para pagar depois e quitar posteriormente', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Plano 100 Debito', price_cents: 10000, duration_days: 30 });
  const member = await service.createMember({ name: 'Aluno Debito', document: nextCpf(), plan_id: plan.id });
  store.run("INSERT INTO cash_sessions (staff_name, opening_cents, status) VALUES ('Recepcao', 0, 'open')");

  const res = await service.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    amount_cents: 10000,
    split_payments: [{ method: 'cash', amount_cents: 5000 }],
    debt_cents: 5000,
    debt_due_date: '2026-12-01',
  }, { requireOpenCash: true });

  assert.equal(res.payments.length, 1);
  assert.equal(res.payments[0].amount_cents, 5000);
  assert.equal(res.debt.amount_cents, 5000);
  assert.equal(res.debt.status, 'open');
  assert.equal(res.member.status, 'active');
  assert.equal(res.member.open_debt_cents, 5000);

  // Quita o débito de R$ 50,00 no Pix
  const settled = service.payMemberDebt(res.debt.id, { amount_cents: 5000, method: 'pix' }, { requireOpenCash: true });
  assert.equal(settled.debt.status, 'paid');
  assert.equal(settled.debt.paid_cents, 5000);
  assert.equal(settled.member.open_debt_cents, 0);
  assert.equal(settled.payments[0].method, 'pix');
  assert.equal(settled.payments[0].amount_cents, 5000);
});

test('recordPayment calcula +30 dias do pagamento quando vencido e +30 dias do vencimento quando ainda não venceu', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Mensal 30d Regra', price_cents: 10000, duration_days: 30 });
  const mExpired = await service.createMember({ name: 'Aluno Vencido', document: nextCpf(), plan_id: plan.id });
  const mActive = await service.createMember({ name: 'Aluno Em Dia', document: nextCpf(), plan_id: plan.id });

  // Simular aluno já vencido há 10 dias
  const expiredDue = store.get("SELECT date('now', 'localtime', '-10 days') AS d").d;
  store.run('UPDATE members SET valid_until = ? WHERE id = ?', [expiredDue, mExpired.id]);
  const resExpired = await service.recordPayment({ member_id: mExpired.id, plan_id: plan.id, method: 'pix' });
  const expectedFromToday = store.get("SELECT date('now', 'localtime', '+30 days') AS d").d;
  assert.equal(resExpired.member.valid_until, expectedFromToday);

  // Simular aluno que ainda vai vencer daqui a 5 dias
  const futureDue = store.get("SELECT date('now', 'localtime', '+5 days') AS d").d;
  store.run('UPDATE members SET valid_until = ? WHERE id = ?', [futureDue, mActive.id]);
  const resActive = await service.recordPayment({ member_id: mActive.id, plan_id: plan.id, method: 'pix' });
  const expectedFromDue = store.get("SELECT date('now', 'localtime', '+35 days') AS d").d;
  assert.equal(resActive.member.valid_until, expectedFromDue);
});

test('createMember sem plano contratado cadastra normalmente e mantém acesso bloqueado na catraca', async () => {
  const { store, service } = await createTestEnv();
  const member = await service.createMember({
    name: 'Aluno Sem Plano',
    document: nextCpf(),
    plan_id: null,
  });
  assert.equal(member.plan_id, null);
  assert.equal(member.status, 'pending');
  const access = await service.handleFaceIdentified(member.id);
  assert.equal(access.allowed, false);

  // Atribuir plano e depois remover para "Sem plano"
  const plan = service.listPlans()[0];
  const today = store.get("SELECT date('now', 'localtime') AS today").today;
  await service.savePlanEnrollment(member.id, { plan_id: plan.id, starts_on: today });
  assert.equal((await service.handleFaceIdentified(member.id)).allowed, true);

  await service.savePlanEnrollment(member.id, { plan_id: null });
  const cleared = service.getMember(member.id);
  assert.equal(cleared.plan_id, null);
  assert.equal(cleared.valid_until, null);
  assert.equal(cleared.status, 'pending');
  assert.equal((await service.handleFaceIdentified(member.id)).allowed, false);
});

test('syncMembershipCharges gera cobranca 10 dias antes, remove 2 dias apos vencimento e pagamento nos 2 dias renova +30 dias do pagamento', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Mensal Auto Cobranca', price_cents: 12000, duration_days: 30 });

  // Aluno 1: vence daqui a 10 dias -> deve gerar cobrança automática
  const mSoon = await service.createMember({ name: 'Vence Em 10 Dias', document: nextCpf(), plan_id: plan.id });
  const dueSoon = store.get("SELECT date('now', 'localtime', '+10 days') AS d").d;
  store.run('DELETE FROM membership_charges WHERE member_id = ?', [mSoon.id]);
  store.run("UPDATE members SET status = 'active', valid_until = ? WHERE id = ?", [dueSoon, mSoon.id]);

  // Aluno 2: vence daqui a 15 dias -> NÃO deve gerar cobrança ainda
  const mLater = await service.createMember({ name: 'Vence Em 15 Dias', document: nextCpf(), plan_id: plan.id });
  const dueLater = store.get("SELECT date('now', 'localtime', '+15 days') AS d").d;
  store.run('DELETE FROM membership_charges WHERE member_id = ?', [mLater.id]);
  store.run("UPDATE members SET status = 'active', valid_until = ? WHERE id = ?", [dueLater, mLater.id]);

  // Aluno 3: venceu há 2 dias -> cobrança ainda permanece para pagamento
  const mGrace = await service.createMember({ name: 'Vencido Ha 2 Dias', document: nextCpf(), plan_id: plan.id });
  const dueTwoDaysAgo = store.get("SELECT date('now', 'localtime', '-2 days') AS d").d;
  store.run('DELETE FROM membership_charges WHERE member_id = ?', [mGrace.id]);
  store.run("UPDATE members SET status = 'active', valid_until = ? WHERE id = ?", [dueTwoDaysAgo, mGrace.id]);
  service.createMembershipCharge(mGrace.id, { due: dueTwoDaysAgo, amount: plan.price_cents });

  // Aluno 4: venceu há 3 dias (> 2 dias após o vencimento) -> cobrança não paga deve sumir
  const mStale = await service.createMember({ name: 'Vencido Ha 3 Dias', document: nextCpf(), plan_id: plan.id });
  const dueThreeDaysAgo = store.get("SELECT date('now', 'localtime', '-3 days') AS d").d;
  store.run('DELETE FROM membership_charges WHERE member_id = ?', [mStale.id]);
  store.run("UPDATE members SET status = 'active', valid_until = ? WHERE id = ?", [dueThreeDaysAgo, mStale.id]);
  service.createMembershipCharge(mStale.id, { due: dueThreeDaysAgo, amount: plan.price_cents });

  await service.checkExpiredMembers();

  const cSoon = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [mSoon.id]);
  assert.ok(cSoon, 'Cobrança deve ser gerada 10 dias antes do vencimento');
  assert.equal(cSoon.due, dueSoon);
  assert.equal(cSoon.amount, plan.price_cents);

  const cLater = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [mLater.id]);
  assert.equal(cLater, null, 'Não deve gerar cobrança com mais de 10 dias de antecedência');

  const cGrace = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [mGrace.id]);
  assert.ok(cGrace, 'Cobrança com até 2 dias após o vencimento deve permanecer aberta');

  const cStale = store.get('SELECT * FROM membership_charges WHERE member_id = ?', [mStale.id]);
  assert.equal(cStale, null, 'Cobrança não paga deve sumir após 2 dias do vencimento');

  // Pagamento feito nesses 2 dias após o vencimento -> próximo vencimento = 30 dias após o pagamento (hoje + 30)
  const payRes = await service.recordPayment({
    member_id: mGrace.id,
    plan_id: plan.id,
    charge_id: cGrace.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });
  const expected30DaysFromToday = store.get("SELECT date('now', 'localtime', '+30 days') AS d").d;
  assert.equal(payRes.member.valid_until, expected30DaysFromToday);
});

test('onTurnstileRelease notifica liberações reais com nome do aluno ou manual e ignora preview/negado', async () => {
  const { store, service } = await createTestEnv();
  const events = [];
  const unsubscribe = service.onTurnstileRelease((ev) => events.push(ev));

  const plan = service.listPlans()[0];
  const member = await service.createMember({ name: 'Carla Souza', document: nextCpf(), plan_id: plan.id });
  await service.recordPayment({ member_id: member.id, plan_id: plan.id, amount_cents: plan.price_cents, method: 'pix' });
  store.run('UPDATE members SET controlid_user_id = ? WHERE id = ?', [4040, member.id]);

  // Preview e acesso negado não devem notificar a recepção
  service.previewTurnstileDisplay('allowed');
  service.publishTurnstileDisplay('denied', { member, reason: 'Teste' });
  assert.equal(events.length, 0);

  // FaceID autorizado
  const faceRes = await service.handleFaceIdentified(4040);
  assert.equal(faceRes.allowed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].memberId, member.id);
  assert.equal(events[0].memberName, 'Carla Souza');
  assert.equal(events[0].source, 'FaceID');

  // Liberação manual pela recepção
  await service.releaseTurnstile('entry', 'LIBERADO');
  assert.equal(events.length, 2);
  assert.equal(events[1].memberId, null);
  assert.equal(events[1].memberName, 'Recepção (liberação manual)');
  assert.match(events[1].source, /^Liberação manual/);

  unsubscribe();
  await service.releaseTurnstile('entry', 'LIBERADO');
  assert.equal(events.length, 2);
});

test('savePlanEnrollment gera cobrança aberta automaticamente ao adicionar matrícula e remove ao limpar plano', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans().find((p) => p.duration_days > 1);
  assert.ok(plan);
  const member = await service.createMember({ name: 'Lucas Cobranca', document: nextCpf() });
  const today = store.get("SELECT date('now', 'localtime') AS today").today;

  const res = await service.savePlanEnrollment(member.id, { plan_id: plan.id, starts_on: today });
  assert.ok(res.charge, 'Deve retornar a cobrança gerada na matrícula');
  assert.equal(res.charge.due, today);
  assert.equal(res.charge.amount, plan.price_cents);

  const openCharges = store.all('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.equal(openCharges.length, 1);
  assert.equal(openCharges[0].amount, plan.price_cents);

  await service.savePlanEnrollment(member.id, { plan_id: null });
  const remaining = store.all('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.equal(remaining.length, 0);
});

test('recordPayment permite valor maior como crédito e valor menor como desconto ou débito sobre cobrança aberta', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans().find((p) => p.duration_days > 1);
  assert.ok(plan);

  // 1) Pagamento maior -> excedente vira crédito do aluno
  const m1 = await service.createMember({ name: 'Aluno Credito', document: nextCpf() });
  const enr1 = await service.savePlanEnrollment(m1.id, { plan_id: plan.id, starts_on: store.get("SELECT date('now', 'localtime') AS today").today });
  const excess = 3000;
  const r1 = await service.recordPayment({
    member_id: m1.id,
    plan_id: plan.id,
    charge_id: enr1.charge.id,
    amount_cents: plan.price_cents,
    credit_excess_cents: excess,
    method: 'pix',
  });
  assert.equal(r1.payment.amount_cents, plan.price_cents + excess);
  assert.equal(r1.member.credit_cents, excess);

  // 2) Pagamento menor com desconto sobre cobrança aberta (sem gerar débito)
  const m2 = await service.createMember({ name: 'Aluno Desconto', document: nextCpf() });
  const enr2 = await service.savePlanEnrollment(m2.id, { plan_id: plan.id, starts_on: store.get("SELECT date('now', 'localtime') AS today").today });
  const r2 = await service.recordPayment({
    member_id: m2.id,
    plan_id: plan.id,
    charge_id: enr2.charge.id,
    amount_cents: plan.price_cents - 2000,
    method: 'dinheiro',
  });
  assert.equal(r2.payment.amount_cents, plan.price_cents - 2000);
  assert.equal(r2.debt, null);
  const charge2 = store.get('SELECT payment_id FROM membership_charges WHERE id = ?', [enr2.charge.id]);
  assert.equal(charge2.payment_id, r2.payment.id);
});

test('deleteMember remove aluno com partner_access_requests e gateway_charges vinculada a membership_charges', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans()[0];
  const member = await service.createMember({ name: 'Aluno Excluir FK', document: nextCpf(), plan_id: plan.id });
  const charge = service.createMembershipCharge(member.id, { due: '2026-12-01', amount: plan.price_cents });

  store.run(
    "INSERT INTO partner_access_requests (member_id, provider, status) VALUES (?, 'wellhub', 'pending')",
    [member.id],
  );
  store.run(
    "INSERT INTO gateway_charges (provider, external_id, member_id, plan_id, amount_cents, status, membership_charge_id) VALUES ('mercadopago', 'ext-del-1', ?, ?, ?, 'pending', ?)",
    [member.id, plan.id, plan.price_cents, charge.id],
  );

  const res = await service.deleteMember(member.id);
  assert.equal(res.ok, true);
  assert.equal(store.get('SELECT id FROM members WHERE id = ?', [member.id]), null);
  assert.equal(store.get('SELECT id FROM partner_access_requests WHERE member_id = ?', [member.id]), null);
  assert.equal(store.get('SELECT id FROM gateway_charges WHERE member_id = ?', [member.id]), null);
  assert.equal(store.get('SELECT id FROM membership_charges WHERE member_id = ?', [member.id]), null);
});

test('createMember com plano lança primeira cobrança automaticamente, mantém bloqueado até pagar e segue renovações depois', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans().find((p) => p.duration_days > 1);
  assert.ok(plan);

  const member = await service.createMember({
    name: 'Aluno Nova Matricula',
    document: nextCpf(),
    phone: '62999998888',
    plan_id: plan.id,
  });

  const today = store.get("SELECT date('now', 'localtime') AS today").today;
  const openCharge = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.ok(openCharge, 'Deve lançar a primeira cobrança automaticamente na matrícula');
  assert.equal(openCharge.due, today);
  assert.equal(openCharge.amount, plan.price_cents);
  assert.equal(openCharge.source, 'enrollment');

  // Permanece bloqueado até pagar a primeira cobrança
  assert.equal(member.status, 'pending');
  assert.ok(service.getAccessDenial(member));

  // Mesmo após > 2 dias sem pagar, a cobrança inicial de matrícula não é removida pelo sync automático
  const fiveDaysLater = store.get("SELECT date('now', 'localtime', '+5 days') AS d").d;
  service.syncMembershipCharges(fiveDaysLater);
  assert.ok(store.get('SELECT id FROM membership_charges WHERE id = ? AND payment_id IS NULL', [openCharge.id]));

  // Ao pagar a primeira cobrança, quita a cobrança, libera o acesso e cria a vigência
  const paid = await service.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    charge_id: openCharge.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });
  assert.equal(paid.member.status, 'active');
  assert.equal(service.getAccessDenial(paid.member), null);
  assert.equal(store.get('SELECT payment_id FROM membership_charges WHERE id = ?', [openCharge.id]).payment_id, paid.payment.id);

  // Depois segue normalmente gerando a próxima cobrança 10 dias antes do vencimento
  const tenDaysBeforeEnd = store.get("SELECT date(?, '-10 days') AS d", [paid.member.valid_until]).d;
  service.syncMembershipCharges(tenDaysBeforeEnd);
  const nextCharge = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.ok(nextCharge, 'Deve gerar a próxima cobrança normalmente antes do vencimento');
  assert.equal(nextCharge.due, paid.member.valid_until);
});

test('deletePayment exclui pagamento duplicado, recalcula valid_until e reabre cobrança vinculada', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans().find((p) => p.duration_days === 30);
  assert.ok(plan);

  const member = await service.createMember({
    name: 'Victoria Teste Duplicado',
    document: nextCpf(),
    phone: '62984731007',
    plan_id: plan.id,
  });

  const p1 = await service.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });
  const p2 = await service.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });

  assert.notEqual(p2.member.valid_until, p1.member.valid_until);

  const del2 = await service.deletePayment(p2.payment.id);
  assert.equal(del2.ok, true);
  assert.equal(del2.member.valid_until, p1.member.valid_until);
  assert.equal(del2.member.status, 'active');

  const del1 = await service.deletePayment(p1.payment.id);
  assert.equal(del1.ok, true);
  assert.equal(del1.member.valid_until, null);
  assert.equal(del1.member.status, 'pending');
  assert.ok(store.get('SELECT id FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]));
});

test('deletePayment recalcula validade corretamente mesmo quando o primeiro pagamento duplicado e excluido', async () => {
  const { service } = await createTestEnv();
  const mensal = service.listPlans().find((p) => p.duration_days === 30);
  const member = await service.createMember({
    name: 'Victoria Teste Duplicado 2',
    document: nextCpf(),
    phone: '62999990022',
    plan_id: mensal.id,
  });

  const p1 = await service.recordPayment({ member_id: member.id, plan_id: mensal.id, method: 'pix' });
  const p2 = await service.recordPayment({ member_id: member.id, plan_id: mensal.id, method: 'pix' });
  assert.notEqual(p2.member.valid_until, p1.member.valid_until);

  const delFirst = await service.deletePayment(p1.payment.id);
  assert.equal(delFirst.ok, true);
  assert.equal(delFirst.member.valid_until, p1.member.valid_until);
});

test('recordPayment usa o vencimento da cobranca aberta quando valid_until estiver adiantado (ex: importacao)', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Mensal Cobranca Base', price_cents: 10000, duration_days: 30 });
  const mPast = await service.createMember({ name: 'Aluno Cobranca Atrasada', document: nextCpf(), plan_id: plan.id });
  const mFuture = await service.createMember({ name: 'Aluno Cobranca A Vencer', document: nextCpf(), plan_id: plan.id });

  const today = store.get("SELECT date('now', 'localtime') AS d").d;
  const rolledForwardDue = store.get("SELECT date('now', 'localtime', '+20 days') AS d").d;
  const pastChargeDue = store.get("SELECT date('now', 'localtime', '-10 days') AS d").d;
  const upcomingChargeDue = store.get("SELECT date('now', 'localtime', '+2 days') AS d").d;

  store.run('DELETE FROM membership_charges WHERE member_id IN (?, ?)', [mPast.id, mFuture.id]);
  store.run("UPDATE members SET status = 'active', valid_until = ? WHERE id IN (?, ?)", [rolledForwardDue, mPast.id, mFuture.id]);
  store.run(
    'INSERT INTO plan_enrollments (member_id, plan_id, starts_on, ends_on) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET ends_on = excluded.ends_on',
    [mPast.id, plan.id, today, rolledForwardDue],
  );
  store.run(
    'INSERT INTO plan_enrollments (member_id, plan_id, starts_on, ends_on) VALUES (?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET ends_on = excluded.ends_on',
    [mFuture.id, plan.id, today, rolledForwardDue],
  );

  const cPast = service.createMembershipCharge(mPast.id, { due: pastChargeDue, amount: plan.price_cents });
  const cFuture = service.createMembershipCharge(mFuture.id, { due: upcomingChargeDue, amount: plan.price_cents });

  const resPast = await service.recordPayment({
    member_id: mPast.id,
    plan_id: plan.id,
    charge_id: cPast.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });
  const expectedPast = store.get("SELECT date('now', 'localtime', '+30 days') AS d").d;
  assert.equal(resPast.member.valid_until, expectedPast);

  const resFuture = await service.recordPayment({
    member_id: mFuture.id,
    plan_id: plan.id,
    charge_id: cFuture.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  });
  const expectedFuture = store.get('SELECT date(?, \'+30 days\') AS d', [upcomingChargeDue]).d;
  assert.equal(resFuture.member.valid_until, expectedFuture);
});

test('savePlanEnrollment atualiza o valor da cobranca em aberto ao trocar de plano', async () => {
  const { store, service } = await createTestEnv();
  const plan120 = service.createPlan({ name: 'Musculacao Completo', price_cents: 12000, duration_days: 30 });
  const plan100 = service.createPlan({ name: 'Musculacao Normal', price_cents: 10000, duration_days: 30 });
  const member = await service.createMember({
    name: 'Aluna Troca Plano',
    document: nextCpf(),
    plan_id: plan120.id,
  });

  const before = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.equal(before.amount, 12000);

  const today = store.get("SELECT date('now', 'localtime') AS d").d;
  const updated = await service.savePlanEnrollment(member.id, { plan_id: plan100.id, starts_on: today });
  assert.equal(updated.charge.amount, 10000);

  const after = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.equal(after.id, before.id);
  assert.equal(after.amount, 10000);
});

test('createMember exige dados do responsavel apenas para menores de 14 anos e deixa CPF da crianca opcional', async () => {
  const { service } = await createTestEnv();
  const plan = service.createPlan({ name: 'Natação Kids', price_cents: 11000, duration_days: 30 });
  const childBirth = '2018-05-10';
  const parentCpf = nextCpf();

  await assert.rejects(
    () => service.createMember({ name: 'Criança Sem Responsavel', birth_date: childBirth, plan_id: plan.id }),
    /menores de 14 anos/i,
  );

  const child1 = await service.createMember({
    name: 'Pedro Filho',
    birth_date: childBirth,
    guardian_name: 'Ana Mãe',
    guardian_cpf: parentCpf,
    guardian_phone: '62999990001',
    guardian_relationship: 'Mãe',
    plan_id: plan.id,
  });
  assert.equal(child1.document, null);
  assert.equal(child1.guardian_name, 'Ana Mãe');
  assert.equal(child1.phone, '62999990001');

  const child2 = await service.createMember({
    name: 'Julia Filha',
    birth_date: '2020-02-15',
    guardian_name: 'Ana Mãe',
    guardian_cpf: parentCpf,
    guardian_phone: '62999990001',
    guardian_relationship: 'Mãe',
    plan_id: plan.id,
  });
  assert.equal(child2.document, null);
  assert.equal(child2.guardian_cpf, child1.guardian_cpf);

  await assert.rejects(
    () => service.createMember({ name: 'Adulto Sem CPF', birth_date: '1995-01-01', plan_id: plan.id }),
    /CPF é obrigatório/i,
  );
});

test('recordPayment bloqueia split + credito excedente, aceita amount_cents null, quita cobranca em 100% fiado e deletePayment limpa caixa', async () => {
  const { store, service } = await createTestEnv();
  const plan = service.listPlans().find((p) => p.price_cents === 12000);
  const member = await service.createMember({ name: 'Aluno Fiado Total', document: nextCpf(), plan_id: plan.id });

  // split_payments + credit_excess_cents > 0 deve falhar com 400
  await assert.rejects(
    () => service.recordPayment({
      member_id: member.id,
      plan_id: plan.id,
      amount_cents: 12000,
      split_payments: [{ method: 'pix', amount_cents: 6000 }, { method: 'cash', amount_cents: 6000 }],
      credit_excess_cents: 1000,
    }),
    (err) => err.statusCode === 400,
  );

  // 100% fiado (debt_cents === netAmountCents) deve quitar membership_charges e chamar onRecorded
  let recordedCalled = false;
  const fiadoRes = await service.recordPayment(
    {
      member_id: member.id,
      plan_id: plan.id,
      amount_cents: null,
      debt_cents: 12000,
    },
    {
      onRecorded: () => { recordedCalled = true; },
    },
  );
  assert.equal(recordedCalled, true);
  assert.equal(fiadoRes.payments.length, 0);
  assert.equal(fiadoRes.debt.amount_cents, 12000);
  assert.equal(store.all('SELECT id FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]).length, 0);

  // deletePayment remove cash_movements usando session_id quando caixa esta aberto
  const sessionIns = store.run("INSERT INTO cash_sessions (opening_cents, status) VALUES (5000, 'open')");
  const m2 = await service.createMember({ name: 'Aluno Estorno Caixa', document: nextCpf(), plan_id: plan.id });
  const payRes = await service.recordPayment({ member_id: m2.id, plan_id: plan.id, amount_cents: null, method: 'cash' });
  assert.equal(payRes.payment.amount_cents, 12000);
  assert.equal(
    store.all('SELECT id FROM cash_movements WHERE session_id = ? AND type = ?', [sessionIns.lastInsertRowid, 'payment']).length,
    1,
  );

  await service.deletePayment(payRes.payment.id);
  assert.equal(
    store.all('SELECT id FROM cash_movements WHERE session_id = ? AND type = ?', [sessionIns.lastInsertRowid, 'payment']).length,
    0,
  );
});

test('recordPayment bloqueia duplicidade em 3 minutos no caixa e evita baixa dupla na conciliacao Point', async () => {
  const { store, service } = await createTestEnv();
  store.run("INSERT INTO cash_sessions (opening_cents, status) VALUES (5000, 'open')");
  const plan = service.createPlan({ name: 'Mensal AntiDup', price_cents: 10000, duration_days: 30 });
  const member = await service.createMember({ name: 'Aluno AntiDuplicidade', document: nextCpf(), plan_id: plan.id });

  const first = await service.recordPayment(
    { member_id: member.id, plan_id: plan.id, amount_cents: 10000, method: 'pix' },
    { requireOpenCash: true },
  );
  assert.ok(first.payment?.id);

  await assert.rejects(
    () => service.recordPayment(
      { member_id: member.id, plan_id: plan.id, amount_cents: 10000, method: 'pix' },
      { requireOpenCash: true },
    ),
    { statusCode: 409, message: /últimos 3 minutos/ },
  );

  const pointConfirm = await service.recordPayment(
    { member_id: member.id, plan_id: plan.id, amount_cents: 10000, method: 'pix', external_id: 'point_dup_test_1' },
    { reconcileOpenCharge: true },
  );
  assert.equal(pointConfirm.alreadyRecorded, true);
  assert.equal(pointConfirm.payment.id, first.payment.id);
  assert.equal(store.all("SELECT id FROM payments WHERE member_id = ? AND status = 'paid'", [member.id]).length, 1);
});

test('Natacao Infantil/Baby exige turma e recepcao pode cadastrar em turma lotada com allowOverCapacity', async () => {
  const { store, service } = await createTestEnv();
  const gym = new GymService(store);
  const kidsMod = gym.createModality({ name: 'Natação Infantil', description: 'Piscina infantil' });
  const cls = gym.createClass({
    name: 'Infantil 16h',
    modality_id: kidsMod.id,
    schedule: 'Ter/Qui 16:00',
    capacity: 1,
  });

  await assert.rejects(
    () => service.createMember({ name: 'Crianca Sem Turma', document: nextCpf(), modality_id: kidsMod.id }),
    /Selecione uma turma para Natação Infantil/,
  );

  const m1 = await service.createMember({
    name: 'Crianca Um',
    document: nextCpf(),
    modality_id: kidsMod.id,
    class_id: cls.id,
  });
  assert.ok(m1.id > 0);

  await assert.rejects(
    () => service.createMember({ name: 'Crianca Online Bloqueada', document: nextCpf(), modality_id: kidsMod.id, class_id: cls.id }),
    /turma está lotada/i,
  );

  const m2 = await service.createMember(
    { name: 'Crianca Extra Recepcao', document: nextCpf(), modality_id: kidsMod.id, class_id: cls.id },
    { allowOverCapacity: true },
  );
  assert.ok(m2.id > 0);
  const enrolledCount = store.get('SELECT COUNT(*) AS c FROM class_enrollments WHERE class_id = ?', [cls.id]).c;
  assert.equal(enrolledCount, 2);
});

test('syncWellhubExtensionCheckins registra check-in por nome e aprova solicitacao pendente', async () => {
  const { store, service } = await createTestEnv();
  const partnerMember = await service.createMember({
    name: 'Ordely Rodrigues de Sousa',
    document: nextCpf(),
    partner_provider: 'wellhub',
  });
  const partialMember = await service.createMember({
    name: 'Thais Vitoria Moreira Nascimento',
    document: nextCpf(),
    partner_provider: 'wellhub',
  });
  store.run(
    `INSERT INTO partner_access_requests (member_id, provider, status, request_date)
     VALUES (?, 'wellhub', 'pending', date('now', 'localtime'))`,
    [partnerMember.id],
  );

  const res = await service.syncWellhubExtensionCheckins([
    { name: 'ordely rodrigues de sousa', modality: 'Musculação', time_text: '26 de nov., 18:10' },
    { name: 'Thais Vitoria', modality: 'Musculação', time_text: '26 de nov., 20:04' },
    { name: 'Pessoa Nao Cadastrada', modality: 'Musculação' },
  ]);

  assert.equal(res.syncedCount, 2);
  assert.equal(res.matched.length, 2);
  assert.equal(res.matched[0].member_id, partnerMember.id);
  assert.equal(res.matched[0].approved_request, true);
  assert.equal(res.matched[1].member_id, partialMember.id);
  assert.equal(res.unmatched.length, 1);

  const tpCpf = nextCpf();
  const tpMember = await service.createMember({
    name: 'Aluno TotalPass Ext',
    document: tpCpf,
    partner_provider: 'totalpass',
  });
  const tpRes = await service.syncWellhubExtensionCheckins(
    [{ name: 'Aluno TotalPass', cpf: tpCpf, time_text: '20:41' }],
    'totalpass',
  );
  assert.equal(tpRes.syncedCount, 1);
  assert.equal(tpRes.matched[0].member_id, tpMember.id);

  const reqRow = store.get('SELECT status FROM partner_access_requests WHERE member_id = ?', [partnerMember.id]);
  assert.equal(reqRow.status, 'approved');
});

test('recordPayment com autoPrint envia comando print_receipt para o Edge conectado e buildEscPosReceiptBuffer gera ESC/POS', async () => {
  const { store, service } = await createTestEnv();
  const { buildEscPosReceiptBuffer } = await import('../src/services/receiptPrinterService.js');
  const sentCommands = [];
  service.setEdgeCloudHub({
    hasConnectedEdge: () => true,
    enqueueCommand: (type, payload) => sentCommands.push({ type, payload }),
  });
  const plan = service.createPlan({ name: 'Natação Infantil (Mensal)', price_cents: 14000, duration_days: 30 });
  const member = await service.createMember({ name: 'Kaua Henrique', document: nextCpf(), plan_id: plan.id });

  const res = await service.recordPayment(
    { member_id: member.id, plan_id: plan.id, amount_cents: 14000, method: 'cash' },
    { autoPrint: true },
  );
  assert.equal(res.directPrinted, true);
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].type, 'print_receipt');
  assert.equal(sentCommands[0].payload.customerName, 'Kaua Henrique');
  assert.equal(sentCommands[0].payload.totalCents, 14000);

  const escpos = buildEscPosReceiptBuffer(sentCommands[0].payload);
  assert.ok(Buffer.isBuffer(escpos));
  assert.ok(escpos.includes(Buffer.from('TOTAL PAGO')));
  assert.ok(escpos.subarray(-4).equals(Buffer.from([0x1d, 0x56, 0x42, 0x00])));
});
