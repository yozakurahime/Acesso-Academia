import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { GatewayService } from '../src/services/gatewayService.js';
import { CONTEXT_MISSING_HANDOFF_MARKER, WhatsappBotService } from '../src/services/whatsappBotService.js';

test('WhatsappBotService responde duvidas com contexto, mantem historico e identifica aluno', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    gemini_model: 'gemini-2.5-flash',
    whatsapp_bot_context: 'Horário da Academia Oxigênio: Segunda a Sexta das 06h às 22h.',
  });
  store.run(
    "INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 12000)",
  );
  store.run(
    "INSERT INTO members (name, phone, status, valid_until, plan_id) VALUES ('Ana Paula', '64999998888', 'active', '2026-12-01', 1)",
  );

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Olá, Ana! Funcionamos de segunda a sexta, das 06h às 22h.' }] } }],
      }),
    };
  };

  const bot = new WhatsappBotService(store, { fetchFn: fakeFetch });
  const res = await bot.handleIncomingMessage({ phone: '5564999998888', text: 'Qual o horário hoje?' });

  assert.equal(res.requiresHuman, false);
  assert.match(res.reply, /Ana/);
  assert.equal(calls.length, 1);

  const systemText = calls[0].body.contents[0].parts[0].text;
  assert.match(systemText, /Horário da Academia Oxigênio/);
  assert.match(systemText, /Ana Paula/);

  // Segunda mensagem deve incluir o historico anterior
  await bot.handleIncomingMessage({ phone: '5564999998888', text: 'E sábado?' });
  assert.equal(calls.length, 2);
  const secondContents = calls[1].body.contents;
  assert.ok(secondContents.some((c) => c.parts?.[0]?.text === 'Qual o horário hoje?'));

});

test('WhatsappBotService pausa contato ao pedir atendente humano ou quando falta contexto', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
  });

  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: CONTEXT_MISSING_HANDOFF_MARKER }] } }],
    }),
  });

  const bot = new WhatsappBotService(store, { fetchFn: fakeFetch });

  const humanReq = await bot.handleIncomingMessage({
    phone: '5564999991111',
    text: 'Quero falar com um atendente humano por favor',
  });
  assert.equal(humanReq.requiresHuman, true);
  assert.equal(humanReq.reason, 'human_request');
  assert.equal(bot.isPaused('5564999991111'), true);

  // Enquanto pausado, nao responde automaticamente
  const ignored = await bot.handleIncomingMessage({ phone: '5564999991111', text: 'Oi?' });
  assert.equal(ignored, null);

  // Outro contato dispara context_missing vindo do modelo
  const missing = await bot.handleIncomingMessage({ phone: '5564999992222', text: 'Qual o telefone do nutricionista?' });
  assert.equal(missing.requiresHuman, true);
  assert.equal(missing.reason, 'context_missing');
  assert.equal(bot.isPaused('5564999992222'), true);

  // Takeover manual do dono pausa e resumeContact libera
  bot.markHumanTakeover('5564999993333');
  assert.equal(bot.isPaused('5564999993333'), true);
  bot.resumeContact('5564999993333');
  assert.equal(bot.isPaused('5564999993333'), false);

});

test('WhatsappBotService fica inativo quando whatsapp_bot_enabled != 1', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ whatsapp_bot_enabled: '0', gemini_api_key: 'fake-key' });
  const bot = new WhatsappBotService(store);
  const res = await bot.handleIncomingMessage({ phone: '5564999994444', text: 'Oi' });
  assert.equal(res, null);
});

test('WhatsappBotService guia pagamento Mercado Pago para 1 ou mais pessoas em lote e da baixa em todas', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const p1 = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal Teste', 30, 12000)").lastInsertRowid;
  const p2 = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Kids Teste', 30, 9000)").lastInsertRowid;
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Carlos Pai', '11122233344', '5562999991111', 'blocked', '2026-10-01', ?)",
    [p1],
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Lucas Filho', '55566677788', '5562988882222', 'blocked', '2026-10-01', ?)",
    [p2],
  );
  store.run("INSERT INTO cash_sessions (status, opening_cents, opened_at) VALUES ('open', 0, datetime('now', 'localtime'))");

  const accessService = new AccessService(store, null, null);
  const mpCalls = [];
  const fakeMpFetch = async (url, init = {}) => {
    mpCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/v1/payments') && (init.method || 'GET') === 'POST') {
      const payload = {
        id: 99887766,
        status: 'pending',
        point_of_interaction: {
          transaction_data: {
            qr_code: '000201010212PIX_LOTE_210_REAIS',
            qr_code_base64: 'ZmFrZQ==',
            ticket_url: 'https://mercadopago.com.br/pix/99887766',
          },
        },
      };
      return { ok: true, status: 201, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    const payload = { id: 99887766, status: 'approved', transaction_amount: 210 };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  const gatewayService = new GatewayService(store, accessService, { fetchFn: fakeMpFetch });
  const bot = new WhatsappBotService(store, { gatewayService });

  const step1 = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Quero pagar minha mensalidade' });
  assert.match(step1.reply, /Carlos Pai/);
  assert.match(step1.reply, /120,00/);

  const step2 = await bot.handleIncomingMessage({ phone: '5562999991111', text: '55566677788' });
  assert.match(step2.reply, /Lucas Filho/);
  assert.match(step2.reply, /210,00/);

  const discountAttempt = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Tenho desconto, posso pagar menos?' });
  assert.match(discountAttempt.reply, /não aplicamos descontos/i);
  assert.match(discountAttempt.reply, /210,00/);

  const step3 = await bot.handleIncomingMessage({ phone: '5562999991111', text: '1' });
  assert.match(step3.reply, /000201010212PIX_LOTE_210_REAIS/);
  assert.equal(mpCalls[0].body.transaction_amount, 210);

  const step4 = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Já paguei' });
  assert.match(step4.reply, /Pagamento confirmado/);

  const payments = store.all('SELECT member_id, amount_cents, method FROM payments ORDER BY member_id');
  assert.equal(payments.length, 2);
  assert.deepEqual(payments.map((p) => [p.member_id, p.amount_cents, p.method]), [
    [1, 12000, 'pix'],
    [2, 9000, 'pix'],
  ]);
  const m1 = store.get('SELECT status FROM members WHERE id = 1');
  const m2 = store.get('SELECT status FROM members WHERE id = 2');
  assert.equal(m1.status, 'active');
  assert.equal(m2.status, 'active');

  const cashMovements = store.all('SELECT * FROM cash_movements');
  assert.equal(cashMovements.length, 0);
  const onlineSummary = gatewayService.getOnlineCashSummary();
  assert.equal(onlineSummary.total_cents, 21000);
  assert.equal(onlineSummary.total_count, 1);
});

test('OnlineSalesBotService guia matricula nova pelo WhatsApp (plano -> nome -> CPF -> Pix Mercado Pago)', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  store.run("INSERT INTO plans (name, duration_days, price_cents, active) VALUES ('Natação Infantil (Mensal)', 30, 14000, 1)");
  store.run("INSERT INTO plans (name, duration_days, price_cents, active) VALUES ('Natação Baby (Mensal)', 30, 14000, 1)");
  const accessService = new AccessService(store, null, null);
  let lastPixBody = null;
  const fakeMpFetch = async (_url, init) => {
    lastPixBody = init?.body ? JSON.parse(init.body) : null;
    const payload = {
      id: 77665544,
      status: 'pending',
      point_of_interaction: {
        transaction_data: {
          qr_code: '000201010212PIX_NOVA_MATRICULA',
          qr_code_base64: 'ZmFrZQ==',
        },
      },
    };
    return { ok: true, status: 201, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const gatewayService = new GatewayService(store, accessService, { fetchFn: fakeMpFetch });
  const bot = new WhatsappBotService(store, { gatewayService, accessService });

  const s1 = await bot.handleIncomingMessage({ phone: '5562991234567', text: 'Quero me matricular' });
  assert.match(s1.reply, /nome completo/i);

  const kids = await bot.handleIncomingMessage({ phone: '5562991234599', text: 'Quero fazer matrícula na Natação Infantil' });
  assert.equal(kids.requiresHuman, true);
  assert.equal(kids.reason, 'kids_swim_reception_only');
  assert.match(kids.reply, /Natação Baby.*Natação Infantil/i);

  const s2 = await bot.handleIncomingMessage({ phone: '5562991234567', text: 'Mariana Souza Lima' });
  assert.match(s2.reply, /CPF/i);

  const s3Email = await bot.handleIncomingMessage({ phone: '5562991234567', text: '52998224725' });
  assert.match(s3Email.reply, /e-mail/i);

  const s3 = await bot.handleIncomingMessage({ phone: '5562991234567', text: 'Mariana@Gmail.com' });
  assert.match(s3.reply, /Confira se os dados estão corretos/);
  assert.match(s3.reply, /Mariana Souza Lima/);
  assert.match(s3.reply, /529\.982\.247-25/);
  assert.match(s3.reply, /mariana@gmail\.com/);

  const s3Confirm = await bot.handleIncomingMessage({ phone: '5562991234567', text: '1' });
  assert.match(s3Confirm.reply, /Cadastro pronto para \*Mariana Souza Lima\*/);
  assert.match(s3Confirm.reply, /Escolha o número do plano/);
  assert.doesNotMatch(s3Confirm.reply, /Infantil|Baby/i);

  const s4 = await bot.handleIncomingMessage({ phone: '5562991234567', text: '1' });
  assert.match(s4.reply, /Matrícula adicionada para \*Mariana Souza Lima\*/);

  const s5 = await bot.handleIncomingMessage({ phone: '5562991234567', text: '1' });
  assert.match(s5.reply, /000201010212PIX_NOVA_MATRICULA/);
  assert.equal(lastPixBody?.payer?.email, 'mariana@gmail.com');

  const created = store.get("SELECT id, name, status FROM members WHERE document = '529.982.247-25'");
  assert.equal(created.name, 'Mariana Souza Lima');
  assert.equal(created.status, 'pending');
});

test('WhatsappBotService garante privacidade: nao colide DDD, nao vaza terceiros no pagamento e persiste historico isolado', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const p1 = store.run("INSERT INTO plans (name, duration_days, price_cents, active) VALUES ('Musculacao Mensal', 30, 12900, 1)").lastInsertRowid;
  // Mesmo sufixo de 8 digitos (99998888), mas DDD diferente (11 vs 64)
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Maria Silva', '99988877766', '5511999998888', 'active', '2026-12-30', ?)",
    [p1],
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Maria Oliveira', '12345678901', '5562911112222', 'active', '2026-12-30', ?)",
    [p1],
  );

  const calls = [];
  const fakeFetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Olá! Temos o plano Musculacao Mensal por R$ 129,00.' }] } }],
      }),
    };
  };

  const accessService = new AccessService(store, null, null);
  const gatewayService = new GatewayService(store, accessService);
  const bot1 = new WhatsappBotService(store, { fetchFn: fakeFetch, gatewayService });

  // Contato com DDD 64 nao deve receber dados da Maria de DDD 11
  await bot1.handleIncomingMessage({ phone: '5564999998888', text: 'Quais os planos?' });
  const sysPrompt = calls[0].contents[0].parts[0].text;
  assert.doesNotMatch(sysPrompt, /Maria Silva/);
  assert.match(sysPrompt, /Musculacao Mensal/);

  // Simula reinicio do servidor criando nova instancia do bot: deve carregar historico do SQLite apenas deste telefone
  bot1.recordChatMessage({ phone: '5564999998888', direction: 'in', senderType: 'customer', body: 'Quais os planos?' });
  bot1.recordChatMessage({ phone: '5511977776666', direction: 'in', senderType: 'customer', body: 'Segredo de outro chat' });
  const bot2 = new WhatsappBotService(store, { fetchFn: fakeFetch, gatewayService });
  await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'E o horario?' });
  const reloadedContents = JSON.stringify(calls[1].contents);
  assert.match(reloadedContents, /Quais os planos\?/);
  assert.doesNotMatch(reloadedContents, /Segredo de outro chat/);

  // Busca parcial por "Maria" no pagamento nao deve enumerar alunas nem finais de CPF
  await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'Quero pagar' });
  const enumAttempt = await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'Maria' });
  assert.doesNotMatch(enumAttempt.reply, /Maria Silva/);
  assert.doesNotMatch(enumAttempt.reply, /Maria Oliveira/);
  assert.doesNotMatch(enumAttempt.reply, /7766|8901/);
  await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'cancelar' });

  // Handoff grava handoff_summary e resumeContact limpa
  const handoff = await bot2.handleIncomingMessage({ phone: '5564955554444', text: 'Quero falar com atendente' });
  assert.equal(handoff.requiresHuman, true);
  const chatRow = store.get('SELECT needs_human, handoff_summary FROM whatsapp_chats WHERE phone = ?', ['5564955554444']);
  assert.equal(Number(chatRow.needs_human), 1);
  assert.match(chatRow.handoff_summary, /Solicitou atendente/);
  bot2.resumeContact('5564955554444');
  const resumedRow = store.get('SELECT needs_human, handoff_summary FROM whatsapp_chats WHERE phone = ?', ['5564955554444']);
  assert.equal(Number(resumedRow.needs_human), 0);
  assert.equal(resumedRow.handoff_summary, null);

  // Contexto financeiro: cobrança em aberto aparece apenas para o dono exato do WhatsApp
  store.run("INSERT INTO membership_charges (member_id, due, amount) VALUES (1, '2026-11-10', 12900)");
  await bot2.handleIncomingMessage({ phone: '5511999998888', text: 'Tenho alguma pendencia?' });
  const ownerPrompt = calls[calls.length - 1].contents[0].parts[0].text;
  assert.match(ownerPrompt, /cobrança em aberto: R\$\s*129,00/);
  await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'E a Maria tem pendencia?' });
  const otherPrompt = calls[calls.length - 1].contents[0].parts[0].text;
  assert.doesNotMatch(otherPrompt, /cobrança em aberto/);
  assert.doesNotMatch(otherPrompt, /Maria Silva/);

  // Nota interna fica salva apenas para a recepcao e nunca vai para o prompt do bot
  bot2.setInternalNote('5564999998888', 'Combinado pagar sexta-feira na recepcao');
  const chatWithNote = bot2.getChatMessages('5564999998888').chat;
  assert.equal(chatWithNote.internal_note, 'Combinado pagar sexta-feira na recepcao');
  await bot2.handleIncomingMessage({ phone: '5564999998888', text: 'Qual o telefone?' });
  const promptAfterNote = JSON.stringify(calls[calls.length - 1].contents);
  assert.doesNotMatch(promptAfterNote, /Combinado pagar sexta-feira/);

  // Retomada automatica apos expiracao do bot_paused_until
  const nowMs = Date.now();
  bot2.pauseContact('5564944443333', 5000, nowMs);
  assert.equal(bot2.isPaused('5564944443333', nowMs + 1000), true);
  assert.equal(bot2.isPaused('5564944443333', nowMs + 6000), false);

  // Respostas rapidas configuraveis
  assert.ok(bot2.getQuickReplies().length >= 4);
  const savedQr = bot2.saveQuickReplies([{ label: 'Teste', text: 'Mensagem teste' }]);
  assert.deepEqual(savedQr, [{ label: 'Teste', text: 'Mensagem teste' }]);
});

test('OnlineSalesBotService reconhece CPF sem pontuacao (02466829142) para aluno salvo com mascara (024.668.291-42)', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'APP_USR_TEST',
  });
  const access = new AccessService(store, { syncMember: async () => ({ synced: true }) });
  const gateway = new GatewayService(store, access, { fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  const plan = access.listPlans().find((p) => p.duration_days > 1);

  await access.createMember({
    name: 'Angélica Karla da Silva',
    document: '024.668.291-42',
    phone: '62994156152',
    plan_id: plan.id,
  });

  const bot = new WhatsappBotService(store, {
    gatewayService: gateway,
    accessService: access,
    geminiApiKey: '',
  });

  const res = await bot.handleIncomingMessage({
    phone: '5562988887777',
    text: '02466829142',
  });

  assert.ok(res);
  assert.equal(res.requiresHuman, false);
  assert.match(res.reply, /Angélica Karla da Silva/);
  assert.match(res.reply, /Pix Copia e Cola/i);
});

test('OnlineSalesBotService aceita variação leve no nome (sem conector ou erro de 1 letra) e informa quando falta plano', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'APP_USR_TEST',
  });
  const access = new AccessService(store, { syncMember: async () => ({ synced: true }) });
  const gateway = new GatewayService(store, access, { fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  const plan = access.listPlans().find((p) => p.duration_days > 1);

  await access.createMember({
    name: 'Angélica Karla da Silva',
    document: '024.668.291-42',
    phone: '62994156152',
    plan_id: plan.id,
  });
  await access.createMember({
    name: 'Carlos Eduardo Pereira',
    document: '153.509.460-56',
    phone: '62991112222',
  });

  const bot = new WhatsappBotService(store, {
    gatewayService: gateway,
    accessService: access,
    geminiApiKey: '',
  });

  await bot.handleIncomingMessage({ phone: '5562977776666', text: 'quero pagar' });
  const fuzzyRes = await bot.handleIncomingMessage({
    phone: '5562977776666',
    text: 'Angelica Carla Silva',
  });
  assert.ok(fuzzyRes);
  assert.match(fuzzyRes.reply, /Angélica Karla da Silva/);
  assert.match(fuzzyRes.reply, /Pix Copia e Cola/i);

  await bot.handleIncomingMessage({ phone: '5562966665555', text: 'quero pagar' });
  const noPlanRes = await bot.handleIncomingMessage({
    phone: '5562966665555',
    text: 'Carlos Eduardo Pereira',
  });
  assert.ok(noPlanRes);
  assert.match(noPlanRes.reply, /Encontrei o cadastro de \*Carlos\*/);
  assert.match(noPlanRes.reply, /não há um plano vinculado/i);

  // Escolhe o plano 1 (Mensal) para o aluno ja cadastrado sem matricula e exibe menu de pagamento
  const pickPlan = await bot.handleIncomingMessage({ phone: '5562966665555', text: '1' });
  assert.ok(pickPlan);
  assert.match(pickPlan.reply, /Matrícula adicionada/i);
  assert.match(pickPlan.reply, /Pix Copia e Cola/i);
});

test('OnlineSalesBotService respeita online_available e regras de turmas fechadas/lotadas', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'APP_USR_TEST',
  });
  const access = new AccessService(store, { syncMember: async () => ({ synced: true }) });
  const gateway = new GatewayService(store, access, { fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
  const bot = new WhatsappBotService(store, { accessService: access, gatewayService: gateway });

  store.run("INSERT INTO plans (name, duration_days, price_cents, active, online_available) VALUES ('VIP Oculto', 30, 30000, 1, 0)");
  store.run("INSERT INTO plans (name, duration_days, price_cents, active, online_available) VALUES ('Hidroginástica 2x', 30, 16000, 1, 1)");
  store.run("INSERT INTO modalities (name, active) VALUES ('Hidroginástica', 1)");
  const hidroMod = store.get("SELECT id FROM modalities WHERE name = 'Hidroginástica'");
  store.run(
    "INSERT INTO classes (modality_id, name, schedule, capacity, active, allow_new_enrollments, online_enrollment_mode) VALUES (?, 'Hidro 07h', 'Seg/Qua 07:00', 10, 1, 0, 'auto')",
    [hidroMod.id],
  );

  const step1 = await bot.handleIncomingMessage({ phone: '5562955554444', text: 'quero me matricular' });
  assert.ok(step1);
  assert.match(step1.reply, /nome completo/i);
  await bot.handleIncomingMessage({ phone: '5562955554444', text: 'Aluno Teste Turma' });
  const stepAskEmail = await bot.handleIncomingMessage({ phone: '5562955554444', text: '52998224725' });
  assert.match(stepAskEmail.reply, /e-mail/i);
  const stepConfirm = await bot.handleIncomingMessage({ phone: '5562955554444', text: 'pular' });
  assert.match(stepConfirm.reply, /Confira se os dados estão corretos/);
  const stepPlans = await bot.handleIncomingMessage({ phone: '5562955554444', text: 'sim' });
  assert.ok(stepPlans);
  assert.doesNotMatch(stepPlans.reply, /VIP Oculto/);
  assert.match(stepPlans.reply, /Hidroginástica 2x/);

  const hidroIdx = stepPlans.reply.split('\n').find((line) => line.includes('Hidroginástica 2x'))?.match(/\*(\d+)\.\*/)?.[1];
  assert.ok(hidroIdx);
  const step2 = await bot.handleIncomingMessage({ phone: '5562955554444', text: hidroIdx });
  assert.ok(step2);
  assert.equal(step2.requiresHuman, true);
  assert.equal(step2.reason, 'class_unavailable_online');
  // Mesmo com a turma fechada online, o cadastro ja foi salvo!
  const savedMember = store.get("SELECT id, name, status FROM members WHERE document = '529.982.247-25'");
  assert.equal(savedMember.name, 'Aluno Teste Turma');
  assert.equal(savedMember.status, 'pending');
});

test('OnlineSalesBotService permite conferir/corrigir dados e cadastrar várias pessoas no mesmo atendimento', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const accessService = new AccessService(store, null, null);
  let lastChargeBody = null;
  const fakeMpFetch = async (_url, init) => {
    lastChargeBody = init?.body ? JSON.parse(init.body) : null;
    const payload = {
      id: 88990011,
      status: 'pending',
      point_of_interaction: {
        transaction_data: {
          qr_code: '000201010212PIX_MULTI_CADASTRO',
          qr_code_base64: 'ZmFrZQ==',
        },
      },
    };
    return { ok: true, status: 201, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const gatewayService = new GatewayService(store, accessService, { fetchFn: fakeMpFetch });
  const bot = new WhatsappBotService(store, { gatewayService, accessService });
  const phone = '5562988887777';

  await bot.handleIncomingMessage({ phone, text: 'Quero me matricular' });
  await bot.handleIncomingMessage({ phone, text: 'Ana Clara Errada' });
  await bot.handleIncomingMessage({ phone, text: '52998224725' });
  const check1 = await bot.handleIncomingMessage({ phone, text: 'pular' });
  assert.match(check1.reply, /Confira se os dados estão corretos/);
  assert.match(check1.reply, /Ana Clara Errada/);

  // Pede para corrigir e envia os dados certos
  const fix = await bot.handleIncomingMessage({ phone, text: 'corrigir' });
  assert.match(fix.reply, /Vamos corrigir os dados/i);
  await bot.handleIncomingMessage({ phone, text: 'Ana Clara Silva' });
  await bot.handleIncomingMessage({ phone, text: '52998224725' });
  const check2 = await bot.handleIncomingMessage({ phone, text: 'pular' });
  assert.match(check2.reply, /Ana Clara Silva/);
  const confirm1 = await bot.handleIncomingMessage({ phone, text: '1' });
  assert.match(confirm1.reply, /Cadastro pronto para \*Ana Clara Silva\*/);

  // Escolhe plano 1 para Ana Clara Silva
  const payMenu1 = await bot.handleIncomingMessage({ phone, text: '1' });
  assert.match(payMenu1.reply, /Ana Clara Silva/);
  assert.match(payMenu1.reply, /cadastrar outra pessoa/i);

  // Escolhe 3 para cadastrar segunda pessoa no mesmo atendimento
  const nextPerson = await bot.handleIncomingMessage({ phone, text: '3' });
  assert.match(nextPerson.reply, /nome completo/i);
  await bot.handleIncomingMessage({ phone, text: 'Beatriz Clara Silva' });
  await bot.handleIncomingMessage({ phone, text: '15350946056' });
  const check3 = await bot.handleIncomingMessage({ phone, text: 'pular' });
  assert.match(check3.reply, /Beatriz Clara Silva/);
  assert.match(check3.reply, /153\.509\.460-56/);

  const confirm2 = await bot.handleIncomingMessage({ phone, text: 'sim' });
  assert.match(confirm2.reply, /Cadastro pronto para \*Beatriz Clara Silva\*/);

  // Escolhe plano 1 para Beatriz: menu de pagamento deve somar as duas pessoas
  const payMenu2 = await bot.handleIncomingMessage({ phone, text: '1' });
  assert.match(payMenu2.reply, /Ana Clara Silva/);
  assert.match(payMenu2.reply, /Beatriz Clara Silva/);

  // Gera 1 único Pix para as duas juntas
  const pixRes = await bot.handleIncomingMessage({ phone, text: '1' });
  assert.match(pixRes.reply, /000201010212PIX_MULTI_CADASTRO/);
  assert.match(pixRes.reply, /Ana Clara Silva/);
  assert.match(pixRes.reply, /Beatriz Clara Silva/);
  assert.ok(lastChargeBody);

  const m1 = store.get("SELECT id, name FROM members WHERE document = '529.982.247-25'");
  const m2 = store.get("SELECT id, name FROM members WHERE document = '153.509.460-56'");
  assert.equal(m1.name, 'Ana Clara Silva');
  assert.equal(m2.name, 'Beatriz Clara Silva');
});

test('WhatsappBotService transcreve audios com fallback de modelo e salva transcricao no chat mesmo com bot pausado', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    gemini_transcribe_model: 'modelo-inexistente',
    gemini_model: 'gemini-2.5-flash',
  });
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('modelo-inexistente')) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Qual o horário da natação hoje?' }] } }],
      }),
    };
  };
  const bot = new WhatsappBotService(store, { fetchFn: fakeFetch });
  const phone = '5562993334444';
  bot.pauseContact(phone, 60_000);

  const saved = bot.recordChatMessage({
    phone,
    direction: 'in',
    senderType: 'customer',
    body: '',
    mediaType: 'audio',
    mediaUrl: '/api/whatsapp/media/audio_teste.ogg',
  });
  assert.ok(saved?.id);

  // Mesmo com o contato pausado, transcribeAndSaveAudioMessage salva a transcricao no historico
  const transcript = await bot.transcribeAndSaveAudioMessage({
    chatMessageId: saved.id,
    audioBuffer: Buffer.from('fake-ogg'),
    audioMimeType: 'audio/ogg',
  });
  assert.equal(transcript, 'Qual o horário da natação hoje?');
  assert.ok(calls.some((u) => u.includes('modelo-inexistente')));
  assert.ok(calls.some((u) => u.includes('gemini-2.5-flash')));

  const row = store.get('SELECT body, media_type, media_url FROM whatsapp_chat_messages WHERE id = ?', [saved.id]);
  assert.equal(row.media_type, 'audio');
  assert.equal(row.media_url, '/api/whatsapp/media/audio_teste.ogg');
  assert.match(row.body, /Qual o horário da natação hoje\?/);

  const chat = store.get('SELECT last_message FROM whatsapp_chats WHERE phone = ?', [phone]);
  assert.match(chat.last_message, /Qual o horário da natação hoje\?/);
});

test('OnlineSalesBotService reconhece frases naturais como "fechar a matricula dele" sem capturar duvida de taxa de matricula', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const accessService = new AccessService(store, null, null);
  const gatewayService = new GatewayService(store, accessService);
  const himeCalls = [];
  const fakeFetch = async () => {
    himeCalls.push(1);
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Não cobramos taxa de matrícula!' }] } }] }),
    };
  };
  const bot = new WhatsappBotService(store, { gatewayService, accessService, fetchFn: fakeFetch });

  const faq = await bot.handleIncomingMessage({ phone: '5562994441111', text: 'Vocês cobram taxa de matrícula?' });
  assert.equal(himeCalls.length, 1);
  assert.match(faq.reply, /taxa de matrícula/i);

  const naturalEnroll = await bot.handleIncomingMessage({
    phone: '5562986601004',
    text: 'Meu marido fez uma aula de natação experimental ontem.. gostaria de fechar a matrícula dele.',
  });
  assert.ok(naturalEnroll);
  assert.match(naturalEnroll.reply, /nome completo/i);
  assert.equal(himeCalls.length, 1);
});

test('OnlineSalesBotService nao confunde duvida de vencimento/treino ou perguntas gerais com fluxo de pagamento', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const accessService = new AccessService(store, null, null);
  const gatewayService = new GatewayService(store, accessService);
  const geminiCalls = [];
  const fakeFetch = async () => {
    geminiCalls.push(1);
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Com a parcela vencida a catraca bloqueia após o vencimento.' }] } }] }),
    };
  };
  const bot = new WhatsappBotService(store, { gatewayService, accessService, fetchFn: fakeFetch });

  const dueQuestion = await bot.handleIncomingMessage({
    phone: '5562991112233',
    text: 'Oi boa tarde minha parcela venceu hoje mais só consigo pagar amanhã hoje ainda consigo treinar?',
  });
  assert.equal(geminiCalls.length, 1);
  assert.doesNotMatch(dueQuestion.reply, /informe o \*?CPF/i);

  const pixFaq = await bot.handleIncomingMessage({
    phone: '5562991112233',
    text: 'Vocês aceitam pix?',
  });
  assert.equal(geminiCalls.length, 2);
  assert.doesNotMatch(pixFaq.reply, /informe o \*?CPF/i);

  const startPay = await bot.handleIncomingMessage({
    phone: '5562991112233',
    text: 'Quero pagar minha mensalidade',
  });
  assert.match(startPay.reply, /informe o \*?CPF/i);
  assert.equal(geminiCalls.length, 2);

  const followUpQuestion = await bot.handleIncomingMessage({
    phone: '5562991112233',
    text: 'Então hoje ainda posso ir',
  });
  assert.equal(geminiCalls.length, 3);
  assert.doesNotMatch(followUpQuestion.reply, /Não encontrei nenhum aluno/i);
});

test('OnlineSalesBotService tranca matricula pelo WhatsApp sem pedir atestado medico', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    controlid_mock_mode: 'true',
  });
  const accessService = new AccessService(store, null, null);
  const planId = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Musculação', 30, 10000)").lastInsertRowid;
  const member = await accessService.createMember({
    name: 'Marlene Teste',
    document: '52998224725',
    phone: '5562992223344',
    plan_id: planId,
  });

  const bot = new WhatsappBotService(store, { accessService });

  const res = await bot.handleIncomingMessage({
    phone: '5562992223344',
    text: 'So que eu pedi pra trancar que fiz cirurgia e não posso fazer esforço',
  });
  assert.ok(res);
  assert.match(res.reply, /trancada com sucesso/i);
  assert.match(res.reply, /Não é necessário enviar atestado médico/i);

  const updated = accessService.getMember(member.id);
  assert.equal(updated.frozen_until, '9999-12-31');

  const again = await bot.handleIncomingMessage({
    phone: '5562992223344',
    text: 'Quero trancar minha matrícula',
  });
  assert.ok(again);
  assert.match(again.reply, /já está trancada/i);
  assert.match(again.reply, /Não exigimos atestado médico/i);
});

test('WhatsappBotService.setCampaignOptOut bloqueia e reativa disparos automaticos por telefone e cancela fila pendente', async () => {
  const store = await DatabaseStore.create(null);
  const { WhatsappService } = await import('../src/services/whatsappService.js');
  const wa = new WhatsappService(store);
  const bot = new WhatsappBotService(store);

  const planId = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 10000)").lastInsertRowid;
  const memberId = store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Jonathas Errado', '52998224725', '5562993334455', 'active', '2026-12-01', ?)",
    [planId],
  ).lastInsertRowid;

  const queued = wa.enqueueMessage({
    memberId,
    phone: '5562993334455',
    kind: 'due_reminder',
    refKey: '2026-12-01',
    message: 'Lembrete pendente',
  });
  assert.ok(queued);

  const optRes = bot.setCampaignOptOut('5562993334455', true);
  assert.equal(optRes.opt_out, 1);

  const logRow = store.get('SELECT status, error FROM whatsapp_logs WHERE id = ?', [queued.id]);
  assert.equal(logRow.status, 'skipped');

  const blocked = wa.enqueueMessage({
    memberId: null,
    phone: '5562993334455',
    kind: 'inactive',
    refKey: '2026-12-02',
    message: 'Oi, sumiu!',
  });
  assert.equal(blocked, null);

  bot.setCampaignOptOut('5562993334455', false);
  const reenabled = wa.enqueueMessage({
    memberId,
    phone: '5562993334455',
    kind: 'inactive',
    refKey: '2026-12-03',
    message: 'Voltou!',
  });
  assert.ok(reenabled);
});

test('WhatsappBotService.getChatMessages retorna todos os perfis vinculados ao mesmo telefone (pais e filhos)', async () => {
  const store = await DatabaseStore.create(null);
  const bot = new WhatsappBotService(store);
  const planId = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Natação Kids', 30, 11000)").lastInsertRowid;
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Filho Um', '52998224725', '5562994445566', 'active', '2026-12-10', ?)",
    [planId],
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Filho Dois', '11122233344', '5562994445566', 'active', '2026-12-10', ?)",
    [planId],
  );
  bot.recordChatMessage({ phone: '5562994445566', direction: 'in', senderType: 'customer', body: 'Oi, quero ver as aulas' });

  const thread = bot.getChatMessages('5562994445566');
  assert.equal(thread.linkedMembers.length, 2);
  assert.deepEqual(
    thread.linkedMembers.map((m) => m.name).sort(),
    ['Filho Dois', 'Filho Um'],
  );
});
