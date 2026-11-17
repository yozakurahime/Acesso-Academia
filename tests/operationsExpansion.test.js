import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { ToletusClient } from '../src/services/toletusClient.js';
import { AccessService } from '../src/services/accessService.js';
import { fitnessToday } from '../src/services/fitnessProgress.js';

let cpfSeq = 300000001;
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

async function createTestEnv() {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', tolerance_days: '2' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const service = new AccessService(store, controlId, toletus);
  return { store, controlId, toletus, service };
}

test('getCurrentOccupancy, antipassback_minutes and max_capacity enforce entry rules', async () => {
  const { store, service } = await createTestEnv();
  const mensal = service.listPlans().find((p) => p.name === 'Mensal');

  const m1 = await service.createMember({ name: 'Ana Paula', document: nextCpf(), plan_id: mensal.id });
  const m2 = await service.createMember({ name: 'Bruno Lima', document: nextCpf(), plan_id: mensal.id });
  await service.recordPayment({ member_id: m1.id, plan_id: mensal.id, amount_cents: mensal.price_cents });
  await service.recordPayment({ member_id: m2.id, plan_id: mensal.id, amount_cents: mensal.price_cents });

  store.updateSettings({ antipassback_minutes: '10', max_capacity: '1' });

  // 1st member enters -> allowed, occupancy becomes 1
  const res1 = await service.handleFaceIdentified(m1.controlid_user_id);
  assert.equal(res1.allowed, true);
  const occ1 = service.getCurrentOccupancy();
  assert.equal(occ1.count, 1);
  assert.equal(occ1.maxCapacity, 1);
  assert.deepEqual(occ1.members.map((m) => m.id), [m1.id]);

  // 1st member tries consecutive pass within antipassback window -> denied
  const resAp = await service.handleFaceIdentified(m1.controlid_user_id);
  assert.equal(resAp.allowed, false);
  assert.match(resAp.message, /antipassback/i);

  // 2nd member tries to enter when max_capacity=1 is full -> denied
  const resCap = await service.handleFaceIdentified(m2.controlid_user_id);
  assert.equal(resCap.allowed, false);
  assert.match(resCap.message, /Lotação máxima/i);

  // Disable antipassback and simulate m1 exiting (2nd pass) -> occupancy drops to 0, m2 can enter
  store.updateSettings({ antipassback_minutes: '0' });
  const res1Exit = await service.handleFaceIdentified(m1.controlid_user_id);
  assert.equal(res1Exit.allowed, true);
  assert.equal(service.getCurrentOccupancy().count, 0);

  const res2 = await service.handleFaceIdentified(m2.controlid_user_id);
  assert.equal(res2.allowed, true);
  assert.equal(service.getCurrentOccupancy().count, 1);
});

test('plan allowed_start_time/allowed_end_time and weekly_limit are enforced in getAccessDenial', async () => {
  const { store, service } = await createTestEnv();

  const hhmm = store.get("SELECT strftime('%H:%M', 'now', 'localtime') AS hhmm").hhmm;
  const [curH, curM] = hhmm.split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const outsideStart = `${pad((curH + 2) % 24)}:${pad(curM)}`;
  const outsideEnd = `${pad((curH + 3) % 24)}:${pad(curM)}`;

  const restrictedPlan = service.createPlan({
    name: 'Horário Restrito',
    duration_days: 30,
    price_cents: 8000,
    allowed_start_time: outsideStart,
    allowed_end_time: outsideEnd,
    weekly_limit: 2,
  });

  const member = await service.createMember({ name: 'Carla Dias', document: nextCpf(), plan_id: restrictedPlan.id });
  await service.recordPayment({ member_id: member.id, plan_id: restrictedPlan.id, amount_cents: restrictedPlan.price_cents });

  const reloaded = service.getMember(member.id);
  assert.match(service.getAccessDenial(reloaded), /Fora do horário permitido/i);

  // Update plan window to cover current time, keep weekly_limit = 2
  const windowStart = `${pad((curH + 23) % 24)}:00`;
  const windowEnd = `${pad((curH + 1) % 24)}:59`;
  service.updatePlan(restrictedPlan.id, {
    name: 'Horário Restrito',
    duration_days: 30,
    price_cents: 8000,
    allowed_start_time: windowStart,
    allowed_end_time: windowEnd,
    weekly_limit: 2,
  });
  assert.equal(service.getAccessDenial(reloaded), null);

  // Insert 2 FaceID visits on earlier days this week (or today - 1 / today - 2 within same week)
  const today = fitnessToday();
  const baseDate = new Date(`${today}T12:00:00Z`);
  const dayOfWeek = (baseDate.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  if (dayOfWeek >= 2) {
    const d1 = new Date(baseDate.getTime() - 86400000).toISOString().slice(0, 10);
    const d2 = new Date(baseDate.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    store.run(
      `INSERT INTO access_logs (member_id, member_name, event_code, event_label, occurred_at) VALUES (?, ?, 7, 'Acesso autorizado (FaceID)', ?)`,
      [member.id, member.name, `${d1} 10:00:00`],
    );
    store.run(
      `INSERT INTO access_logs (member_id, member_name, event_code, event_label, occurred_at) VALUES (?, ?, 7, 'Acesso autorizado (FaceID)', ?)`,
      [member.id, member.name, `${d2} 10:00:00`],
    );
    assert.match(service.getAccessDenial(reloaded), /Limite semanal/i);
  } else {
    // Early in the week (Mon/Tue): lower weekly_limit to 1 and log a visit today to confirm same-day re-entry is allowed,
    // or log a visit on Monday when today is Tuesday to confirm denial.
    service.updatePlan(restrictedPlan.id, {
      name: 'Horário Restrito',
      duration_days: 30,
      price_cents: 8000,
      allowed_start_time: windowStart,
      allowed_end_time: windowEnd,
      weekly_limit: 1,
    });
    const otherDay = dayOfWeek === 1
      ? new Date(baseDate.getTime() - 86400000).toISOString().slice(0, 10)
      : today;
    store.run(
      `INSERT INTO access_logs (member_id, member_name, event_code, event_label, occurred_at) VALUES (?, ?, 7, 'Acesso autorizado (FaceID)', ?)`,
      [member.id, member.name, `${otherDay} 10:00:00`],
    );
    if (otherDay !== today) {
      assert.match(service.getAccessDenial(reloaded), /Limite semanal/i);
    } else {
      assert.equal(service.getAccessDenial(reloaded), null);
    }
  }
});

test('freezeMember blocks access while frozen and unfreezeMember extends valid_until and plan_enrollments.ends_on', async () => {
  const { store, service } = await createTestEnv();
  const mensal = service.listPlans().find((p) => p.name === 'Mensal');

  const member = await service.createMember({ name: 'Diego Souza', document: nextCpf(), plan_id: mensal.id });
  await service.recordPayment({ member_id: member.id, plan_id: mensal.id, amount_cents: mensal.price_cents });
  const beforeValid = service.getMember(member.id).valid_until;

  const frozen = await service.freezeMember(member.id, { days: 10, reason: 'Viagem' });
  assert.ok(frozen.member.frozen_until);
  assert.equal(frozen.member.frozen_reason, 'Viagem');
  assert.match(service.getAccessDenial(frozen.member), /trancada/i);

  // Simulate freeze started 5 days ago
  const fiveDaysAgo = store.get("SELECT date('now', 'localtime', '-5 days') AS d").d;
  store.run(`UPDATE members SET updated_at = ? WHERE id = ?`, [`${fiveDaysAgo} 10:00:00`, member.id]);

  const unfrozen = await service.unfreezeMember(member.id);
  assert.equal(unfrozen.member.frozen_until, null);
  assert.equal(unfrozen.member.frozen_reason, null);
  assert.ok(unfrozen.extendedDays >= 5);
  assert.ok(unfrozen.member.valid_until > beforeValid);
  const enrollment = service.getPlanEnrollment(member.id);
  assert.equal(enrollment.ends_on, unfrozen.member.valid_until);
  assert.equal(service.getAccessDenial(unfrozen.member), null);

  // Não pode trancar uma segunda vez no mesmo mês (limite 1x/mês)
  await assert.rejects(
    service.freezeMember(member.id, { days: 400, reason: 'Segundo no mês' }),
    /1x por mês/i,
  );

  // Em outro mês pode trancar sem limite de dias (inclusive > 365 dias ou indeterminado)
  store.run(`UPDATE member_freezes SET started_at = '2020-01-01' WHERE member_id = ?`, [member.id]);
  const longFreeze = await service.freezeMember(member.id, { days: 500, reason: 'Licença longa' });
  assert.ok(longFreeze.member.frozen_until);
});

test('createVisitor allows day-use access until visitor_expires_at and signMemberContract records PAR-Q/contract', async () => {
  const { store, service } = await createTestEnv();
  const today = store.get("SELECT date('now', 'localtime') AS today").today;

  const { visitor } = await service.createVisitor({ name: 'Visitante Teste', phone: '11988887777', valid_until: today });
  assert.equal(visitor.is_visitor, 1);
  assert.equal(visitor.visitor_expires_at, today);
  assert.equal(service.getAccessDenial(visitor), null);

  // Expire visitor
  const yesterday = store.get("SELECT date('now', 'localtime', '-1 day') AS d").d;
  store.run('UPDATE members SET visitor_expires_at = ? WHERE id = ?', [yesterday, visitor.id]);
  const expiredVisitor = service.getMember(visitor.id);
  assert.match(service.getAccessDenial(expiredVisitor), /visitante expirado/i);

  // PAR-Q & Contract
  const signed = service.signMemberContract(visitor.id, { signature: 'Visitante Teste' });
  assert.ok(signed.parq_signed_at);
  assert.ok(signed.contract_signed_at);
  assert.equal(signed.contract_signature, 'Visitante Teste');
});

test('syncAllReaders iterates active readers and publishTurnstileDisplay includes occupancy and isBirthday', async () => {
  const { store, controlId, service } = await createTestEnv();
  const mensal = service.listPlans().find((p) => p.name === 'Mensal');
  const today = fitnessToday();
  const birthDate = `1995-${today.slice(5, 10)}`;

  const member = await service.createMember({
    name: 'Elena Costa',
    document: nextCpf(),
    plan_id: mensal.id,
    birth_date: birthDate,
  });
  await service.recordPayment({ member_id: member.id, plan_id: mensal.id, amount_cents: mensal.price_cents });
  store.run('UPDATE members SET face_registered = 1 WHERE id = ?', [member.id]);

  // Add a second active reader and an inactive reader
  store.run(
    `INSERT INTO readers (name, brand, ip, port, active) VALUES ('Leitor Saida', 'controlid', '192.168.1.99', 80, 1)`,
  );
  store.run(
    `INSERT INTO readers (name, brand, ip, port, active) VALUES ('Leitor Inativo', 'controlid', '192.168.1.100', 80, 0)`,
  );

  const syncedIps = [];
  const origForDevice = controlId.forDevice.bind(controlId);
  controlId.forDevice = (reader) => {
    const client = origForDevice(reader);
    client.syncMember = async (m, allowed) => {
      syncedIps.push({ ip: reader.ip, memberId: m.id, allowed });
      return { controlIdUserId: m.controlid_user_id, allowed, mock: true };
    };
    return client;
  };

  const syncRes = await service.syncAllReaders();
  assert.equal(syncRes.readers.length, 2);
  assert.equal(syncRes.totalSynced, 2);
  assert.equal(syncRes.totalErrors, 0);
  assert.equal(syncedIps.length, 2);

  // Turnstile display with occupancy & isBirthday
  store.updateSettings({ max_capacity: '50' });
  const wId = store.run("INSERT INTO workouts (member_id, title, goal, active) VALUES (?, 'Treino A — Glúteos', 'Hipertrofia', 1)", [member.id]).lastInsertRowid;
  store.run("INSERT INTO workout_exercises (workout_id, exercise_key, exercise_name, sets, reps) VALUES (?, 'agachamento', 'Agachamento', 4, '12')", [wId]);

  service.publishTurnstileDisplay('allowed', { member: service.getMember(member.id), occupancy: 12 });
  const display = service.getTurnstileDisplay();
  assert.equal(display.outcome, 'allowed');
  assert.equal(display.firstName, 'Elena');
  assert.equal(display.occupancy, 12);
  assert.equal(display.isBirthday, true);

  const kiosk = service.getTurnstileKioskDisplay();
  assert.equal(kiosk.fullName, 'Elena Costa');
  assert.equal(kiosk.planName, 'Mensal');
  assert.ok(typeof kiosk.daysRemaining === 'number');
  assert.equal(kiosk.workoutSummary?.title, 'Treino A — Glúteos');
  assert.equal(kiosk.workoutSummary?.exerciseCount, 1);
});
