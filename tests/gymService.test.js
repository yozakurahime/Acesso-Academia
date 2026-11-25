import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { ToletusClient } from '../src/services/toletusClient.js';
import { AccessService } from '../src/services/accessService.js';
import { GymService } from '../src/services/gymService.js';

let cpfSeq = 100000001;
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

async function createEnv(filePath = null) {
  const store = await DatabaseStore.create(filePath);
  store.updateSettings({ controlid_mock_mode: 'true', tolerance_days: '3' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId, toletus);
  const gymService = new GymService(store);
  return { store, accessService, gymService };
}

test('modelos são editáveis e os treinos atribuídos mantêm a cópia original', async () => {
  const { accessService, gymService } = await createEnv();
  const member = await accessService.createMember({ name: 'Aluno modelo', document: nextCpf() });
  const payload = { title: 'Força', exercises: [
    { exercise_key: 'ponte_gluteos', exercise_name: 'Ponte de Glúteos', sets: 2, reps: '12', rest_seconds: 60 },
  ] };
  const template = gymService.saveWorkoutTemplate(payload);
  gymService.createWorkout({ ...template, member_id: member.id });
  gymService.saveWorkoutTemplate({ ...payload, exercises: [{ ...payload.exercises[0], sets: 4 }] }, template.id);
  assert.equal(gymService.listWorkoutTemplates()[0].exercises[0].sets, 4);
  gymService.deleteWorkoutTemplate(template.id);
  assert.equal(gymService.listWorkoutTemplates().length, 0);
  assert.equal(gymService.listWorkoutsByMember(member.id)[0].exercises[0].sets, 2);
  assert.throws(() => gymService.saveWorkoutTemplate({ title: 'Sem exercícios', exercises: [] }), /Adicione/);
});

test('falha ao salvar desfaz a mutação em memória e preserva o banco anterior', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-falha-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { store, accessService } = await createEnv(path.join(directory, 'acesso.sqlite'));
  const member = await accessService.createMember({ name: 'Cadastro de teste', document: nextCpf() });
  const originalSave = store.save;
  store.save = () => { throw new Error('Falha simulada de gravação'); };
  assert.throws(() => store.run("UPDATE members SET status = 'blocked' WHERE id = ?", [member.id]), /Falha simulada/);
  assert.equal(accessService.getMember(member.id).status, 'pending');
  store.save = originalSave;
  store.updateSettings({ gym_name: 'Após falha' });
  const reopened = await DatabaseStore.create(store.filePath);
  assert.equal(reopened.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'pending');
  reopened.db.close();
  store.db.close();
});

test('cadastro e edição rejeitam nome repetido mesmo com diferenças de grafia', async () => {
  const { accessService, gymService } = await createEnv();
  const member = await accessService.createMember({ name: 'João da Silva', document: nextCpf() });
  await assert.rejects(
    accessService.createMember({ name: '  JOAO  DA SILVA  ', document: nextCpf(), access_role: 'instructor' }),
    { statusCode: 409, message: /Já existe um cadastro/ },
  );
  const other = await accessService.createMember({ name: 'Maria Silva', document: nextCpf() });
  assert.throws(() => gymService.updateMember(other.id, { name: 'Joao da Silva' }), { statusCode: 409 });
  assert.equal(gymService.updateMember(member.id, { name: 'JOÃO DA SILVA' }).member.name, 'JOÃO DA SILVA');
});

test('integrante da equipe mantém dados e foto facial ao reabrir o banco', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-equipe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'acesso.sqlite');
  const { store, accessService } = await createEnv(file);
  const member = await accessService.createMember({
    name: 'Funcionária exemplo', access_role: 'staff', document: nextCpf(),
    phone: '11999990000', birth_date: '1990-06-01', sex: 'feminino',
  });
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await accessService.registerFace(member.id, photo.toString('base64'));
  store.db.close();

  const reopened = await DatabaseStore.create(file);
  const saved = new GymService(reopened).getMemberProfile(member.id).member;
  assert.equal(saved.access_role, 'staff');
  assert.equal(saved.document, member.document);
  assert.equal(saved.phone, member.phone);
  assert.equal(saved.birth_date, member.birth_date);
  assert.equal(saved.sex, member.sex);
  assert.equal(saved.face_registered, 1);
  assert.deepEqual(await new AccessService(reopened).getMemberPhoto(member.id), photo);
  reopened.db.close();
});

test('caixa completo: abertura, mensalidade, venda de produto, sangria e fechamento', async () => {
  const { accessService, gymService } = await createEnv();
  const mensal = accessService.listPlans().find((p) => p.name === 'Mensal');
  const aluno = await accessService.createMember({ name: 'Ana Paula', document: nextCpf(), plan_id: mensal.id });
  const payment = { member_id: aluno.id, plan_id: mensal.id, method: 'pix' };
  await assert.rejects(accessService.recordPayment(payment, { requireOpenCash: true }), { code: 'CASH_CLOSED', statusCode: 409 });
  assert.equal(accessService.listPayments().length, 0);
  assert.equal(accessService.getMember(aluno.id).status, 'pending');

  const staff = gymService.listStaff();
  const opened = gymService.openCashSession({
    staff_id: staff[0].id,
    opening_cents: 10000,
    notes: 'Turno manha',
  });
  assert.equal(opened.opening_cents, 10000);
  assert.equal(opened.expected_cents, 10000);

  // Mensalidade entra no caixa aberto
  await accessService.recordPayment(payment, { requireOpenCash: true });

  // Venda de produto decrementa estoque e entra no caixa
  const products = gymService.listProducts();
  const agua = products[0];
  const initialStock = agua.stock;
  gymService.recordSale({ product_id: agua.id, member_id: aluno.id, quantity: 2, method: 'cash' });

  const updatedProduct = gymService.listProducts().find((p) => p.id === agua.id);
  assert.equal(updatedProduct.stock, initialStock - 2);

  // Sangria
  gymService.addManualCashMovement({ type: 'out', amount_cents: 2000, description: 'Compra limpeza' });

  const current = gymService.getCurrentCashSession();
  const expected = 10000 + agua.price_cents * 2 - 2000;
  assert.equal(current.total_in_cents, mensal.price_cents + agua.price_cents * 2);
  assert.equal(current.expected_cents, expected);

  const closed = gymService.closeCashSession({ closing_cents: expected });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closing_cents, expected);
});

test('matrículas validam modalidade e lotação, permitem troca e persistem junto ao acesso e às configurações', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-teste-'));
  t.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const file = path.join(directory, 'acesso.sqlite');
  const { store, accessService, gymService } = await createEnv(file);
  store.updateSettings({ gym_name: 'Academia de teste', tolerance_days: '7' });
  const swim = gymService.createModality({ name: 'Natação Baby' });
  const dance = gymService.createModality({ name: 'Dança' });
  const morning = gymService.createClass({ name: 'Baby manhã', modality_id: swim.id, schedule: '09:00', capacity: 1 });
  const afternoon = gymService.createClass({ name: 'Baby tarde', modality_id: swim.id, schedule: '15:00' });
  const danceClass = gymService.createClass({ name: 'Dança início', modality_id: dance.id, schedule: '10:00' });
  const member = await accessService.createMember({
    name: 'João Teste', document: nextCpf(), phone: '11999990000',
    birth_date: '2020-04-13', sex: 'masculino', modality_id: swim.id, class_id: morning.id,
    guardian_name: 'Maria Teste', guardian_cpf: nextCpf(), guardian_phone: '11999990000', guardian_relationship: 'Mãe',
  });
  assert.equal(member.birth_date, '2020-04-13');
  assert.equal(member.sex, 'masculino');
  gymService.updateMember(member.id, { phone: '11999990001', birth_date: '2020-04-14', sex: 'outro' });
  const other = await accessService.createMember({ name: 'Outro aluno', document: nextCpf() });
  await assert.rejects(accessService.createMember({ name: 'Inválido', document: nextCpf(), modality_id: swim.id, class_id: danceClass.id }), /turma da modalidade/);
  assert.throws(() => gymService.saveEnrollment(other.id, { modality_id: swim.id, class_id: morning.id }), /lotada/);
  assert.throws(() => gymService.saveEnrollment(member.id, { modality_id: swim.id, class_id: danceClass.id }), /turma da modalidade/);
  assert.equal(gymService.getMemberProfile(member.id).classes[0].id, morning.id);
  gymService.saveEnrollment(member.id, { modality_id: swim.id, class_id: afternoon.id });
  gymService.saveEnrollment(member.id, { modality_id: dance.id, class_id: danceClass.id });
  assert.equal(gymService.listClasses().find((row) => row.id === morning.id).enrolled_count, 0);
  gymService.removeEnrollment(member.id, dance.id);
  const today = store.get("SELECT date('now', 'localtime') AS today").today;
  await accessService.savePlanEnrollment(member.id, { plan_id: accessService.listPlans()[1].id, starts_on: today });
  store.db.close();

  const reopened = await DatabaseStore.create(file);
  t.after(() => reopened.db.close());
  assert.equal(reopened.getSettings().gym_name, 'Academia de teste');
  assert.equal(reopened.getSettings().tolerance_days, '7');
  const profile = new GymService(reopened).getMemberProfile(member.id);
  assert.equal(profile.member.status, 'active');
  assert.equal(profile.planEnrollment.starts_on, today);
  assert.equal(profile.member.document, member.document);
  assert.equal(profile.member.phone, '11999990001');
  assert.equal(profile.member.birth_date, '2020-04-14');
  assert.equal(profile.member.sex, 'outro');
  assert.deepEqual(profile.modalities.map((entry) => [entry.name, entry.classes[0].schedule]), [['Natação Baby', '15:00']]);
  const restartedAccess = new AccessService(reopened, new ControlIdClient(() => reopened.getSettings()));
  assert.equal((await restartedAccess.handleFaceIdentified(profile.member.controlid_user_id)).allowed, true);
});

test('perfil do aluno, modalidades, professores, turmas e formas de pagamento', async () => {
  const { accessService, gymService } = await createEnv();

  const mod = gymService.createModality({ name: 'Jiu-Jitsu', description: 'Arte suave' });
  const inst = gymService.createInstructor({ name: 'Prof. Ricardo', specialty: 'Jiu-Jitsu' });
  const cls = gymService.createClass({
    name: 'Jiu-Jitsu Noite',
    modality_id: mod.id,
    instructor_id: inst.id,
    schedule: 'Ter/Qui 19:00',
    capacity: 15,
  });

  const aluno = await accessService.createMember({ name: 'Lucas Mendes', document: nextCpf(), modality_id: mod.id });
  gymService.enrollMemberInClass(cls.id, aluno.id);

  const updated = gymService.updateMember(aluno.id, {
    phone: '11988887777',
    emergency_contact: 'Mae 11977776666',
    notes: 'Apto para treino',
  });
  assert.equal(updated.member.phone, '11988887777');
  assert.equal(updated.classes.length, 1);
  assert.equal(updated.classes[0].name, 'Jiu-Jitsu Noite');

  const pm = gymService.createPaymentMethod({ name: 'Link Asaas' });
  assert.equal(pm.code, 'link_asaas');
  const toggled = gymService.togglePaymentMethod(pm.id);
  assert.equal(toggled.active, 0);
});

test('editar e apagar modalidade atualiza dados, impede duplicidade e desvincula registros ligados', async () => {
  const { store, accessService, gymService } = await createEnv();

  const modA = gymService.createModality({ name: 'Boxe', description: 'Luta em pe' });
  const modB = gymService.createModality({ name: 'Muay Thai', description: 'Tailândia' });
  assert.throws(() => gymService.createModality({ name: 'boxe' }), /Ja existe uma modalidade/);

  const edited = gymService.updateModality(modA.id, { name: 'Boxe Olímpico', description: 'Treino técnico' });
  assert.equal(edited.name, 'Boxe Olímpico');
  assert.equal(edited.description, 'Treino técnico');
  assert.throws(() => gymService.updateModality(modA.id, { name: 'muay thai' }), /Ja existe uma modalidade/);

  const cls = gymService.createClass({
    name: 'Boxe 19h',
    modality_id: modA.id,
    schedule: 'Seg/Qua 19:00',
    capacity: 15,
  });
  const aluno = await accessService.createMember({ name: 'Carlos Lutador', document: nextCpf(), modality_id: modA.id, class_id: cls.id });

  const removed = gymService.deleteModality(modA.id);
  assert.deepEqual(removed, { deleted: true, id: modA.id });
  assert.equal(gymService.listModalities().some((m) => m.id === modA.id), false);
  assert.equal(gymService.listModalities().some((m) => m.id === modB.id), true);

  const memberRow = store.get('SELECT modality_id FROM members WHERE id = ?', [aluno.id]);
  assert.equal(memberRow.modality_id, null);
  assert.equal(store.all('SELECT * FROM member_modalities WHERE modality_id = ?', [modA.id]).length, 0);
  const classRow = store.get('SELECT modality_id FROM classes WHERE id = ?', [cls.id]);
  assert.equal(classRow.modality_id, null);

  assert.throws(() => gymService.deleteModality(modA.id), /Modalidade não encontrada/);
});

test('checkMemberName impede apenas nome igual e libera nomes parecidos ou distintos', async () => {
  const { accessService, gymService } = await createEnv();
  await accessService.createMember({ name: 'Vinícius Almeida Souza', document: nextCpf() });

  const exact = gymService.checkMemberName('  vinicius   almeida souza ');
  assert.equal(exact.valid, false);
  assert.equal(exact.exactMatch, true);
  assert.equal(exact.matches[0].reason, 'exact');

  const similarTypo = gymService.checkMemberName('Vinicius Almeira Souza');
  assert.equal(similarTypo.valid, true);
  assert.equal(similarTypo.exactMatch, false);
  assert.equal(similarTypo.matches.length, 0);

  const partial = gymService.checkMemberName('Vinicius Almeida');
  assert.equal(partial.valid, true);
  assert.equal(partial.exactMatch, false);
  assert.equal(partial.matches.length, 0);

  const distinct = gymService.checkMemberName('Mariana Costa Ferreira');
  assert.equal(distinct.valid, true);
  assert.equal(distinct.exactMatch, false);
  assert.equal(distinct.matches.length, 0);
});

test('CPF é obrigatório, validado matematicamente e bloqueia duplicidade no cadastro e edição', async () => {
  const { accessService, gymService } = await createEnv();

  await assert.rejects(
    accessService.createMember({ name: 'Sem CPF' }),
    { statusCode: 400, message: /CPF é obrigatório/ },
  );
  await assert.rejects(
    accessService.createMember({ name: 'CPF Repetido', document: '111.111.111-11' }),
    { statusCode: 400, message: /CPF inválido/ },
  );
  await assert.rejects(
    accessService.createMember({ name: 'CPF Digito Errado', document: '52998224720' }),
    { statusCode: 400, message: /CPF inválido/ },
  );

  const first = await accessService.createMember({ name: 'Primeiro Aluno', document: '52998224725' });
  assert.equal(first.document, '529.982.247-25');

  assert.deepEqual(gymService.checkMemberCpf('529.982.247-25').reason, 'duplicate');
  assert.equal(gymService.checkMemberCpf('529.982.247-25', first.id).valid, true);
  assert.equal(gymService.checkMemberCpf('11144477735').valid, true);

  await assert.rejects(
    accessService.createMember({ name: 'Segundo Aluno', document: '529.982.247-25' }),
    { statusCode: 409, message: /Já existe um cadastro com esse CPF/ },
  );

  const second = await accessService.createMember({ name: 'Segundo Aluno', document: '11144477735' });
  assert.throws(
    () => gymService.updateMember(second.id, { document: '52998224725' }),
    { statusCode: 409, message: /Já existe um cadastro com esse CPF/ },
  );
  assert.throws(
    () => gymService.updateMember(second.id, { document: '' }),
    { statusCode: 400, message: /CPF é obrigatório/ },
  );
});

test('Gestão de turmas: reserva recorrente, lista de espera e chamada (presente/faltou)', async () => {
  const { accessService, gymService } = await createEnv();
  const mod = gymService.createModality({ name: 'Cross' });
  const cls = gymService.createClass({ name: 'Cross 19h', modality_id: mod.id, schedule: '19:00', capacity: 1 });
  const m1 = await accessService.createMember({ name: 'Aluno 1', document: nextCpf() });
  const m2 = await accessService.createMember({ name: 'Aluno 2', document: nextCpf() });

  const startDate = new Date().toISOString().slice(0, 10);
  const rec = gymService.bookClassRecurring({ classId: cls.id, memberId: m1.id, startDate, weeks: 3 });
  assert.equal(rec.created.length, 3);
  assert.equal(rec.skipped.length, 0);

  // Segundo aluno entra na fila de espera na primeira data
  const wait = gymService.bookClass({ classId: cls.id, memberId: m2.id, bookingDate: startDate });
  assert.equal(wait.status, 'waitlist');

  // Cancelar o primeiro promove o segundo
  const canceled = gymService.cancelClassBooking(rec.created[0].id, null);
  assert.equal(canceled.promoted?.id, wait.id);
  assert.equal(canceled.promoted?.status, 'confirmed');

  // Marcar presença e falta
  const attended = gymService.markBookingAttendance(wait.id, 'attended');
  assert.equal(attended.status, 'attended');
  const noShow = gymService.markBookingAttendance(rec.created[1].id, 'no_show');
  assert.equal(noShow.status, 'no_show');
});

