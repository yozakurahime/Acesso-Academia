import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { WhatsappService, normalizeBrPhone, brPhoneVariants, areEquivalentBrPhones } from '../src/services/whatsappService.js';

test('normalizeBrPhone formata telefones brasileiros e rejeita inválidos', () => {
  assert.equal(normalizeBrPhone('(11) 99999-8888'), '5511999998888');
  assert.equal(normalizeBrPhone('011988887777'), '5511988887777');
  assert.equal(normalizeBrPhone('+55 11 98888-7777'), '5511988887777');
  assert.equal(normalizeBrPhone('12345'), null);
  assert.equal(normalizeBrPhone(''), null);
});

test('WhatsappService enfileira pagamento, vencimento e aluno ausente respeitando deduplicação e limite diário', async () => {
  const store = await DatabaseStore.create(null);
  const wa = new WhatsappService(store, { sleepFn: async () => {} });

  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_notify_payment: '1',
    whatsapp_notify_due: '1',
    whatsapp_due_days_before: '2',
    whatsapp_notify_inactive: '1',
    whatsapp_inactive_days: '10',
    whatsapp_daily_limit: '3',
    whatsapp_window_start: '08:00',
    whatsapp_window_end: '20:00',
  });

  assert.equal(wa.isWithinAllowedWindow(store.getSettings(), new Date('2026-11-14T10:00:00')), true);
  assert.equal(wa.isWithinAllowedWindow(store.getSettings(), new Date('2026-11-14T23:30:00')), false);

  const plan = store.get('SELECT * FROM plans LIMIT 1');
  const m1 = store.run(
    `INSERT INTO members (name, phone, plan_id, status, valid_until) VALUES (?, ?, ?, 'active', ?)`,
    ['João Treino', '11999991111', plan.id, '2026-11-15'],
  ).lastInsertRowid;
  const m2 = store.run(
    `INSERT INTO members (name, phone, plan_id, status, valid_until) VALUES (?, ?, ?, 'active', ?)`,
    ['Maria Sumida', '11999992222', plan.id, '2026-12-20'],
  ).lastInsertRowid;
  const m3 = store.run(
    `INSERT INTO members (name, phone, plan_id, status, valid_until) VALUES (?, ?, ?, 'active', ?)`,
    ['Pedro Frequente', '11999993333', plan.id, '2026-12-20'],
  ).lastInsertRowid;

  // Maria passou há 15 dias; Pedro passou hoje
  store.run(`INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'Acesso autorizado (FaceID)', '2026-10-29 10:00:00')`, [m2]);
  store.run(`INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'Acesso autorizado (FaceID)', '2026-11-14 09:00:00')`, [m3]);

  const now = new Date('2026-11-14T10:00:00');
  const receipt = await wa.enqueuePaymentReceipt({
    member: store.get('SELECT * FROM members WHERE id = ?', [m1]),
    payment: { id: 77, amount_cents: 15000 },
    plan,
  });
  assert.ok(receipt);
  assert.equal(receipt.kind, 'payment');
  assert.match(receipt.message, /João/);
  assert.match(receipt.message, /150,00/);

  // Deduplicação do mesmo pagamento
  const dupReceipt = await wa.enqueuePaymentReceipt({
    member: store.get('SELECT * FROM members WHERE id = ?', [m1]),
    payment: { id: 77, amount_cents: 15000 },
    plan,
  });
  assert.equal(dupReceipt, null);

  // Campanhas fora da janela são ignoradas
  const outside = await wa.runScheduledCampaigns({ now: new Date('2026-11-14T22:00:00') });
  assert.equal(outside.skippedReason, 'outside_window');

  // Dentro da janela: 1 vencimento (João 2026-11-15) + 1 ausente (Maria 15 dias) -> fecha limite diário = 3 (1+1+1)
  const inside = await wa.runScheduledCampaigns({ now });
  assert.equal(inside.dueQueued, 1);
  assert.equal(inside.inactiveQueued, 1);

  const logs = wa.listLogs(10);
  assert.equal(logs.length, 3);
  assert.equal(logs.some((l) => l.member_id === m3), false);

  // Reexecutar não duplica
  const repeat = await wa.runScheduledCampaigns({ now });
  assert.equal(repeat.dueQueued, 0);
  assert.equal(repeat.inactiveQueued, 0);
});

test('WhatsappService cobre boas-vindas, fila de espera, lembrete de aula, revisão de ficha e win-back', async () => {
  const store = await DatabaseStore.create();
  const wa = new WhatsappService(store);
  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_daily_limit: '20',
    whatsapp_window_start: '08:00',
    whatsapp_window_end: '22:00',
    gym_name: 'Academia Oxigênio',
  });

  const now = new Date('2026-11-14T10:00:00');
  const activeId = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until) VALUES (?, ?, ?, 'active', '2026-12-10')",
    ['Lucas Ativo', '10000000101', '11988881001'],
  ).lastInsertRowid;
  const inactiveOldId = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until) VALUES (?, ?, ?, 'blocked', '2026-09-20')",
    ['Carla Ex', '10000000102', '11988881002'],
  ).lastInsertRowid;

  // Ficha antiga (> 45 dias)
  store.run(
    "INSERT INTO workouts (member_id, title, active, created_at, updated_at) VALUES (?, 'Treino A', 1, '2026-09-01 10:00:00', '2026-09-01 10:00:00')",
    [activeId],
  );

  // Aula confirmada para hoje
  const clsId = store.run("INSERT INTO classes (name, schedule, capacity) VALUES ('Spinning', '19:00', 10)").lastInsertRowid;
  const bookingId = store.run(
    "INSERT INTO class_bookings (class_id, member_id, booking_date, status) VALUES (?, ?, '2026-11-14', 'confirmed')",
    [clsId, activeId],
  ).lastInsertRowid;

  const welcome = await wa.enqueueWelcomeMessage({
    member: store.get('SELECT * FROM members WHERE id = ?', [activeId]),
    inviteCode: 'OXI-1234',
  });
  assert.ok(welcome);
  assert.match(welcome.message, /OXI-1234/);
  assert.equal(await wa.enqueueWelcomeMessage({ member: store.get('SELECT * FROM members WHERE id = ?', [activeId]) }), null);

  const promoted = await wa.enqueueWaitlistPromotion({
    booking: store.get('SELECT * FROM class_bookings WHERE id = ?', [bookingId]),
    member: store.get('SELECT * FROM members WHERE id = ?', [activeId]),
    classInfo: store.get('SELECT * FROM classes WHERE id = ?', [clsId]),
  });
  assert.ok(promoted);
  assert.match(promoted.message, /Spinning/);

  const campaigns = await wa.runScheduledCampaigns({ now });
  assert.equal(campaigns.classReminderQueued, 1);
  assert.equal(campaigns.workoutReviewQueued, 1);
  assert.equal(campaigns.winBackQueued, 1);

  const logs = wa.listLogs(20);
  assert.equal(logs.some((l) => l.member_id === inactiveOldId && l.kind === 'winback'), true);
});

test('WhatsappService aplica opt-out automático, spintax e trava de win-back', async () => {
  const store = await DatabaseStore.create();
  const wa = new WhatsappService(store);
  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_daily_limit: '40',
    whatsapp_window_start: '08:00',
    whatsapp_window_end: '22:00',
  });

  const mId = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until) VALUES (?, ?, ?, 'active', '2026-11-15')",
    ['Marcos OptOut', '10000000201', '11977772001'],
  ).lastInsertRowid;

  // Spintax funciona no template
  const rendered = wa.renderTemplate('{Olá|Oi} {primeiro_nome}!', { name: 'Marcos OptOut' });
  assert.match(rendered, /^(Olá|Oi) Marcos!$/);

  // Enfileira e depois aluno responde SAIR
  const queued = wa.enqueueMessage({ memberId: mId, phone: '11977772001', kind: 'due_reminder', refKey: 'due:1', message: 'Teste' });
  assert.ok(queued);
  assert.equal(wa.handleIncomingText('5511977772001', 'SAIR'), true);

  const memberAfter = store.get('SELECT whatsapp_opt_out FROM members WHERE id = ?', [mId]);
  assert.equal(memberAfter.whatsapp_opt_out, 1);
  const logAfter = store.get('SELECT status FROM whatsapp_logs WHERE id = ?', [queued.id]);
  assert.equal(logAfter.status, 'skipped');

  // Nova campanha automática não enfileira enquanto estiver em opt-out
  assert.equal(wa.enqueueMessage({ memberId: mId, phone: '11977772001', kind: 'winback', refKey: 'wb:1', message: 'Volte' }), null);

  // Responder VOLTAR reativa
  assert.equal(wa.handleIncomingText('5511977772001', 'VOLTAR'), true);
  assert.ok(wa.enqueueMessage({ memberId: mId, phone: '11977772001', kind: 'winback', refKey: 'wb:2', message: 'Volte' }));
});

test('WhatsappService enfileira cobranca vencida ontem, check-in de 7 dias e marcos de treinos sem duplicar', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_notify_due: '1',
    whatsapp_notify_welcome: '1',
    whatsapp_daily_limit: '20',
  });
  const wa = new WhatsappService(store);
  const now = new Date(2026, 10, 19, 10, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const isoOffset = (days) => {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const yesterday = isoOffset(-1);
  const sevenDaysAgo = isoOffset(-7);
  const today = isoOffset(0);

  const planId = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 12000)").lastInsertRowid;
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('João Vencido', '20000000001', '62999990001', 'active', ?, ?)",
    [yesterday, planId],
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id, created_at) VALUES ('Paula Nova', '20000000002', '62999990002', 'active', '2026-12-10', ?, ?)",
    [planId, `${sevenDaysAgo} 09:00:00`],
  );
  const m3 = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Carlos Foco', '20000000003', '62999990003', 'active', '2026-12-10', ?)",
    [planId],
  ).lastInsertRowid;
  for (let i = 0; i < 10; i++) {
    store.run(
      "INSERT INTO access_logs (member_id, member_name, event_code, event_label, occurred_at) VALUES (?, 'Carlos Foco', 7, 'Liberado', ?)",
      [m3, `${today} 08:0${i}:00`],
    );
  }

  assert.equal(wa.enqueueOverdueTodayReminders(now), 1);
  assert.equal(wa.enqueueOnboardingCheckins(now), 1);
  assert.equal(wa.enqueueMilestoneMessages(now), 1);

  // Deduplicacao impede reenvio no mesmo ciclo
  assert.equal(wa.enqueueOverdueTodayReminders(now), 0);
  assert.equal(wa.enqueueOnboardingCheckins(now), 0);
  assert.equal(wa.enqueueMilestoneMessages(now), 0);

  const logs = store.all('SELECT kind, message FROM whatsapp_logs ORDER BY id ASC');
  assert.deepEqual(logs.map((l) => l.kind), ['overdue_reminder', 'onboarding_7d', 'milestone']);
  assert.match(logs[0].message, /quero pagar/i);
  assert.match(logs[1].message, /g\.page\/r\//);
  assert.match(logs[2].message, /10 treinos/);
});

test('WhatsappService opera no modo API Oficial Meta (Cloud API) para envio e webhook', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_provider: 'meta_cloud',
    whatsapp_meta_phone_number_id: '555123456789',
    whatsapp_meta_access_token: 'meta-token-teste',
    whatsapp_bot_enabled: '1',
  });

  const sentCalls = [];
  const fakeFetch = async (url, init) => {
    sentCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
  };

  let botReceived = null;
  const wa = new WhatsappService(store, {
    sleepFn: async () => {},
    fetchFn: fakeFetch,
    botDebounceMs: 0,
    onBotMessage: {
      recordChatMessage: () => {},
      markHumanTakeover: () => {},
      handleIncomingMessage: async (msg) => {
        botReceived = msg;
        return { reply: 'Oi! Aqui é a Hime pela API oficial.' };
      },
    },
  });

  const st = wa.getStatus();
  assert.equal(st.provider, 'meta_cloud');
  assert.equal(st.status, 'connected');

  await wa.sendImmediate('62999998888', 'Teste oficial Meta');
  assert.equal(sentCalls.length, 1);
  assert.match(sentCalls[0].url, /\/555123456789\/messages$/);
  assert.equal(sentCalls[0].body.to, '5562999998888');
  assert.equal(sentCalls[0].body.text.body, 'Teste oficial Meta');

  const whRes = await wa.handleMetaWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '5562999998888', profile: { name: 'João Teste' } }],
              messages: [{ id: 'wamid.in.1', from: '5562999998888', type: 'text', text: { body: 'Qual o valor?' } }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(whRes.processed, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(botReceived?.text, 'Qual o valor?');
  assert.equal(sentCalls.length, 2);
  assert.equal(sentCalls[1].body.text.body, 'Oi! Aqui é a Hime pela API oficial.');
});

test('fila pausada não dispara mensagens e modo Meta envia apenas com modelo aprovado', async () => {
  const store = await DatabaseStore.create(null);
  const sends = [];
  const whatsappService = new WhatsappService(store, {
    sleepFn: async () => {},
    fetchFn: async (_url, init) => {
      sends.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.tpl.1' }] }) };
    },
  });
  whatsappService.status = 'connected';
  whatsappService.sock = { sendMessage: async () => sends.push('baileys') };
  store.run("INSERT INTO whatsapp_logs (phone, kind, message, status) VALUES ('556284211039', 'due_reminder', 'Vencimento', 'queued')");

  await whatsappService.processQueue();
  assert.deepEqual(sends, []);
  assert.equal(whatsappService.countQueued(), 1);
  assert.equal(whatsappService.getStatus().queuePausedReason, 'Envios automáticos desativados.');

  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_notify_payment: '1',
    whatsapp_provider: 'meta_cloud',
    whatsapp_meta_phone_number_id: '123456789',
    whatsapp_meta_access_token: 'token-teste',
  });
  assert.equal(whatsappService.enqueueMessage({ phone: '62984211039', kind: 'due_reminder', message: 'Sem template' }), null);

  const memberId = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until) VALUES ('Maria Meta', '52998224725', '62984211039', 'active', '2026-12-20')",
  ).lastInsertRowid;
  const member = store.get('SELECT * FROM members WHERE id = ?', [memberId]);
  await whatsappService.enqueuePaymentReceipt({
    member,
    payment: { id: 99, amount_cents: 10000 },
    plan: { name: 'Musculação Mensal' },
  });
  await new Promise((r) => setTimeout(r, 40));
  await whatsappService.processQueue();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].type, 'template');
  assert.equal(sends[0].template.name, 'confirmacao_pagamento');
  assert.equal(sends[0].template.components[0].parameters.length, 4);
});

test('WhatsappService enfileira recuperacao de pendentes e anexa link MP em lembretes de cobranca', async () => {
  const store = await DatabaseStore.create();
  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_notify_due: '1',
    mp_access_token: 'TEST-MP',
  });
  const planId = store.get('SELECT id FROM plans LIMIT 1')?.id
    || store.run("INSERT INTO plans (name, duration_days, price_cents, active) VALUES ('Mensal', 30, 10000, 1)").lastInsertRowid;
  const pendingId = store.run(
    "INSERT INTO members (name, document, phone, status, access_role, plan_id, created_at) VALUES ('Lucas Pendente', '52998224725', '62991110000', 'pending', 'student', ?, datetime('now', 'localtime', '-3 hours'))",
    [planId],
  ).lastInsertRowid;

  const wa = new WhatsappService(store, { authDir: null });
  wa.setGatewayService({
    createBatchPayment: async () => ({
      charge: { payment_url: 'https://mpago.la/teste-link-123' },
    }),
  });

  const queued = wa.enqueuePendingRecoveryReminders();
  assert.equal(queued, 1);
  assert.equal(wa.enqueuePendingRecoveryReminders(), 0);

  const recoveryRow = store.get("SELECT * FROM whatsapp_logs WHERE kind = 'pending_recovery' AND member_id = ?", [pendingId]);
  assert.ok(recoveryRow);
  assert.match(recoveryRow.message, /quero pagar/i);

  const dueRow = wa.enqueueMessage({
    memberId: pendingId,
    phone: '62991110000',
    kind: 'due_reminder',
    refKey: 'due:2026-12-01',
    message: 'Seu plano vence em breve!',
  });
  const dueItem = store.get('SELECT * FROM whatsapp_logs WHERE id = ?', [dueRow.id]);
  const enriched = await wa._enrichMessageWithPaymentLink(dueItem, store.getSettings());
  assert.match(enriched, /https:\/\/mpago\.la\/teste-link-123/);
});

test('WhatsappService registra envios automaticos e manuais (sendImmediate) no Atendimento WhatsApp', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_enabled: '1',
    whatsapp_provider: 'meta_cloud',
    whatsapp_meta_phone_number_id: '123456789',
    whatsapp_meta_access_token: 'token-teste',
  });
  const wa = new WhatsappService(store, {
    sleepFn: async () => {},
    fetchFn: async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.out.1' }] }) }),
  });

  await wa.sendImmediate('62995551122', 'Olá! Segue seu link de pagamento.', { kind: 'billing_link', senderType: 'human' });
  const msgsAfterImmediate = store.all('SELECT direction, sender_type, body FROM whatsapp_chat_messages WHERE phone = ?', ['5562995551122']);
  assert.equal(msgsAfterImmediate.length, 1);
  assert.equal(msgsAfterImmediate[0].direction, 'out');
  assert.equal(msgsAfterImmediate[0].sender_type, 'human');
  assert.match(msgsAfterImmediate[0].body, /link de pagamento/i);

  const chatRow = store.get('SELECT last_message, unread_count FROM whatsapp_chats WHERE phone = ?', ['5562995551122']);
  assert.equal(chatRow.unread_count, 0);
  assert.match(chatRow.last_message, /link de pagamento/i);
});

test('brPhoneVariants e areEquivalentBrPhones tratam 12 e 13 digitos BR como equivalentes sem colidir DDD', () => {
  assert.deepEqual(brPhoneVariants('556292093611'), ['556292093611', '5562992093611']);
  assert.deepEqual(brPhoneVariants('5562992093611'), ['5562992093611', '556292093611']);
  assert.equal(areEquivalentBrPhones('556292093611', '5562992093611'), true);
  assert.equal(areEquivalentBrPhones('(62) 9209-3611', '62992093611'), true);
  assert.equal(areEquivalentBrPhones('5511992093611', '5562992093611'), false);
  assert.equal(areEquivalentBrPhones('123', '5562992093611'), false);
  assert.deepEqual(brPhoneVariants('invalido'), []);
});

test('WhatsappService.handleIncomingText sincroniza opt-out e reativacao entre 12 e 13 digitos sem duplicar chat ou colidir DDD', async () => {
  const store = await DatabaseStore.create(null);
  const service = new WhatsappService(store, {});
  store.run(
    "INSERT INTO members (name, document, phone, status, access_role) VALUES ('Maria Goias', '52998224725', '6292093611', 'active', 'student')",
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, access_role) VALUES ('Outro DDD', '15350946056', '11992093611', 'active', 'student')",
  );
  store.run(
    "INSERT INTO whatsapp_chats (phone, opt_out, last_message_at) VALUES ('556292093611', 0, datetime('now', 'localtime'))",
  );

  assert.equal(service.handleIncomingText('5562992093611', 'sair'), true);
  assert.equal(store.all('SELECT phone FROM whatsapp_chats').length, 1);
  assert.equal(store.get("SELECT opt_out FROM whatsapp_chats WHERE phone = '556292093611'").opt_out, 1);
  assert.equal(store.get("SELECT whatsapp_opt_out FROM members WHERE phone = '6292093611'").whatsapp_opt_out, 1);
  assert.equal(store.get("SELECT whatsapp_opt_out FROM members WHERE phone = '11992093611'").whatsapp_opt_out, 0);
  assert.equal(service.enqueueMessage({ phone: '556292093611', kind: 'due_reminder', message: 'Teste' }), null);

  assert.equal(service.handleIncomingText('5562992093611', 'voltar'), true);
  assert.equal(store.all('SELECT phone FROM whatsapp_chats').length, 1);
  assert.equal(store.get("SELECT opt_out FROM whatsapp_chats WHERE phone = '556292093611'").opt_out, 0);
  assert.equal(store.get("SELECT whatsapp_opt_out FROM members WHERE phone = '6292093611'").whatsapp_opt_out, 0);
  assert.ok(service.enqueueMessage({ phone: '556292093611', kind: 'due_reminder', message: 'Teste liberado' }));
});

test('WhatsappService consolida lembretes de vencimento e atraso em 1 mensagem quando ha mais de uma matricula no mesmo numero', async () => {
  const store = await DatabaseStore.create(null);
  const service = new WhatsappService(store, {});
  store.run(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('whatsapp_enabled', '1'), ('whatsapp_notify_due', '1'), ('whatsapp_due_days_before', '1')",
  );

  store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Musculacao Mensal', 30, 10000)");
  const planId = store.get('SELECT id FROM plans LIMIT 1').id;

  const now = new Date('2026-11-27T12:00:00');
  store.run(
    "INSERT INTO members (name, document, phone, plan_id, status, valid_until, access_role) VALUES ('Lorena Braga', '52998224725', '62998325661', ?, 'active', '2026-11-27', 'student')",
    [planId],
  );
  store.run(
    "INSERT INTO members (name, document, phone, plan_id, status, valid_until, access_role) VALUES ('Keylla Braga', '39053344705', '62998325661', ?, 'active', '2026-11-28', 'student')",
    [planId],
  );

  const dueCount = service.enqueueDueReminders(now);
  assert.equal(dueCount, 1);
  const dueRows = store.all("SELECT message FROM whatsapp_logs WHERE kind = 'due_reminder'");
  assert.equal(dueRows.length, 1);
  assert.match(dueRows[0].message, /Lorena/);
  assert.match(dueRows[0].message, /Keylla/);

  store.run("UPDATE members SET valid_until = '2026-11-26'");
  const overdueCount = service.enqueueOverdueTodayReminders(now);
  assert.equal(overdueCount, 1);
  const overdueRows = store.all("SELECT message FROM whatsapp_logs WHERE kind = 'overdue_reminder'");
  assert.equal(overdueRows.length, 1);
  assert.match(overdueRows[0].message, /Lorena/);
  assert.match(overdueRows[0].message, /Keylla/);
});
