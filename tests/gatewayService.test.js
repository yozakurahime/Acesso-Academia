import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { AccessService } from '../src/services/accessService.js';
import { GatewayService } from '../src/services/gatewayService.js';

test('GatewayService gera Pix no Mercado Pago e dá baixa via webhook sem duplicar', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId);

  const plan = accessService.listPlans().find((p) => p.price_cents === 12000);
  const member = await accessService.createMember({ name: 'Lucas MP', document: '52998224725', plan_id: plan.id });
  const installment = accessService.createMembershipCharge(member.id, { due: '2020-01-01', amount: 12000 });

  const mockFetch = async (url, opts = {}) => {
    if (url.endsWith('/v1/payments') && opts.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            id: 987654321,
            point_of_interaction: {
              transaction_data: {
                qr_code: '00020101021226890014br.gov.bcb.pix...',
                qr_code_base64: 'iVBORw0KGgo=',
                ticket_url: 'https://mpago.la/test',
              },
            },
          };
        },
      };
    }
    if (url.endsWith('/v1/payments/987654321')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 987654321, status: 'approved', transaction_amount: 120 };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const gw = new GatewayService(store, accessService, { fetchFn: mockFetch });
  const charge = await gw.createPixCharge({ member_id: member.id });
  assert.equal(charge.provider, 'mercadopago');
  assert.equal(charge.external_id, '987654321');
  assert.equal(charge.membership_charge_id, installment.id);
  assert.equal(charge.qr_code, '00020101021226890014br.gov.bcb.pix...');

  const [res1, concurrent] = await Promise.all([
    gw.handleWebhook('mercadopago', { type: 'payment', data: { id: '987654321' } }),
    gw.handleWebhook('mercadopago', { type: 'payment', data: { id: '987654321' } }),
  ]);
  assert.equal(res1.paid, true);
  assert.equal(concurrent.paid, true);
  assert.equal(res1.alreadyPaid, false);

  // Segunda chamada de webhook é idempotente
  const res2 = await gw.handleWebhook('mercadopago', { type: 'payment', data: { id: '987654321' } });
  assert.equal(res2.paid, true);
  assert.equal(store.all('SELECT id FROM payments WHERE member_id = ?', [member.id]).length, 1);
  assert.ok(store.get('SELECT payment_id FROM membership_charges WHERE id = ?', [installment.id]).payment_id);
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'active');
});

test('Checkout do portal e WhatsApp reutilizam a cobrança mais antiga e dão baixa uma vez', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const [plan, otherPlan] = access.listPlans();
  const member = await access.createMember({ name: 'Aluno Checkout', document: '52998224725', phone: '11987654321', plan_id: plan.id });
  const oldest = access.createMembershipCharge(member.id, { due: '2024-01-01', amount: 9500 });
  const next = access.createMembershipCharge(member.id, { due: '2024-02-01', amount: 11000 });
  let preference;
  let created = 0;
  let paidAmount = 95;
  const gateway = new GatewayService(store, access, { fetchFn: async (url, options) => {
    if (url.endsWith('/checkout/preferences')) {
      preference = JSON.parse(options.body);
      created++;
      return { ok: true, json: async () => ({ id: 'pref-a', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-a' }) };
    }
    assert.match(url, /\/v1\/payments\/(search\?|1$)/);
    const payment = { id: 1, currency_id: 'BRL', status: 'approved', transaction_amount: paidAmount,
      external_reference: preference.external_reference, payment_type_id: 'credit_card' };
    return { ok: true, json: async () => url.includes('/search?') ? { results: [payment] } : payment };
  } });
  const [online, shared] = await Promise.all([
    gateway.createCheckoutCharge({ member_id: member.id, plan_id: otherPlan.id }),
    gateway.createWhatsAppCheckout(member.id),
  ]);
  assert.equal(created, 1);
  assert.equal(online.membership_charge_id, oldest.id);
  assert.equal(preference.items[0].unit_price, 95);
  assert.equal(online.id, shared.charge.id);
  const link = new URL(shared.whatsapp_url);
  assert.equal(link.pathname, '/5511987654321');
  assert.ok(link.searchParams.get('text').includes(online.payment_url));
  paidAmount = 10;
  await assert.rejects(gateway.checkChargeStatus(online.id), /não corresponde/);
  paidAmount = 95;
  const [webhook, checked] = await Promise.all([
    gateway.handleWebhook('mercadopago', { type: 'payment', data: { id: 1 } }),
    gateway.checkChargeStatus(online.id),
  ]);
  assert.equal(webhook.paid, true);
  assert.equal(checked.paid, true);
  assert.equal(store.get('SELECT COUNT(*) AS total FROM payments WHERE member_id = ?', [member.id]).total, 1);
  assert.equal(store.get('SELECT method FROM payments WHERE member_id = ?', [member.id]).method, 'credit');
  assert.equal(store.get('SELECT payment_id FROM membership_charges WHERE id = ?', [next.id]).payment_id, null);
});

test('Mercado Pago Assinatura Recorrente: cria link, sincroniza/webhook dá baixa idempotente e cancela', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_SUB' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId);

  const plan = accessService.listPlans().find((p) => p.price_cents === 12000) || accessService.listPlans()[0];
  const member = await accessService.createMember({
    name: 'Mariana MP Recorrente',
    document: '11144477735',
    email: 'mariana@oxigenio.com',
    plan_id: plan.id,
  });

  let preStatus = 'pending';
  let capturedExtRef = null;
  const fetchMock = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.endsWith('/preapproval') && method === 'POST') {
      const body = JSON.parse(opts.body);
      capturedExtRef = body.external_reference;
      assert.equal(body.auto_recurring.frequency, 1);
      assert.equal(body.auto_recurring.frequency_type, 'months');
      assert.equal(body.auto_recurring.transaction_amount, 120);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'pre_mp_001',
          status: 'pending',
          init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre_mp_001',
        }),
      };
    }
    if (url.endsWith('/preapproval/pre_mp_001') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'pre_mp_001', status: preStatus, next_payment_date: '2026-12-14T00:00:00Z' }),
      };
    }
    if (url.includes('/v1/payments/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: 555001,
              status: 'approved',
              transaction_amount: 120,
              payment_type_id: 'credit_card',
              external_reference: capturedExtRef,
            },
          ],
        }),
      };
    }
    if (url.endsWith('/v1/payments/555001') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 555001,
          status: 'approved',
          transaction_amount: 120,
          payment_type_id: 'credit_card',
          external_reference: capturedExtRef,
        }),
      };
    }
    if (url.endsWith('/preapproval/pre_mp_001') && method === 'PUT') {
      preStatus = 'cancelled';
      return { ok: true, status: 200, json: async () => ({ id: 'pre_mp_001', status: 'cancelled' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const gw = new GatewayService(store, accessService, { fetchFn: fetchMock });

  const sub = await gw.createMpSubscription({ member_id: member.id, plan_id: plan.id, cycle: 'MONTHLY' });
  assert.equal(sub.preapproval_id, 'pre_mp_001');
  assert.equal(sub.status, 'pending');
  assert.ok(sub.init_point.includes('pre_mp_001'));

  // Webhook de pagamento da assinatura dá baixa e ativa aluno
  preStatus = 'authorized';
  const wh = await gw.handleWebhook('mercadopago', { type: 'payment', data: { id: '555001' } });
  assert.equal(wh.paid, true);
  assert.equal(wh.alreadyPaid, false);
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'active');

  // Sync manual atualiza status para active e não duplica pagamento
  const syncRes = await gw.syncMpSubscription(sub.id);
  assert.equal(syncRes.settledCount, 0);
  assert.equal(syncRes.subscription.status, 'active');

  // Cancelamento
  const cancelRes = await gw.cancelMpSubscription(sub.id);
  assert.equal(cancelRes.subscription.status, 'canceled');
});

test('Mercado Pago Point Smart: lista terminais, envia cobrança, dá baixa via webhook/check e cancela', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_POINT', mp_point_terminal_id: 'PAX_A910__SMART01' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId);

  const plan = accessService.listPlans().find((p) => p.price_cents === 12000) || accessService.listPlans()[0];
  const member = await accessService.createMember({ name: 'Carlos Point', document: '39053344705', plan_id: plan.id });

  let orderStatus = 'created';
  let capturedOrderBody = null;
  const fetchMock = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.endsWith('/terminals/v1/list')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { terminals: [{ id: 'PAX_A910__SMART01', operating_mode: 'PDV' }] } }),
      };
    }
    if (url.endsWith('/terminals/v1/setup') && method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ terminals: [{ id: 'PAX_A910__SMART01', operating_mode: 'PDV' }] }) };
    }
    if (url.endsWith('/v1/orders') && method === 'POST') {
      capturedOrderBody = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ id: 'ORD_MP_01', status: 'created' }) };
    }
    if (url.endsWith('/v1/orders/ORD_MP_01') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'ORD_MP_01',
          status: orderStatus,
          transactions: { payments: [{ status: orderStatus, amount: '120.00', payment_method: { type: 'debit_card' } }] },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const gw = new GatewayService(store, accessService, { fetchFn: fetchMock });

  const terminals = await gw.listPointTerminals();
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].id, 'PAX_A910__SMART01');

  const pdvRes = await gw.setPointTerminalMode('PAX_A910__SMART01', 'PDV');
  assert.equal(pdvRes.operatingMode, 'PDV');

  const order = await gw.createPointOrder({ member_id: member.id, plan_id: plan.id });
  assert.equal(order.order_id, 'ORD_MP_01');
  assert.equal(capturedOrderBody.type, 'point');
  assert.equal(capturedOrderBody.config.point.terminal_id, 'PAX_A910__SMART01');
  assert.equal(capturedOrderBody.transactions.payments[0].amount, '120.00');

  const pendingCheck = await gw.checkPointOrder(order.id);
  assert.equal(pendingCheck.paid, false);

  orderStatus = 'processed';
  const wh = await gw.handleWebhook('mercadopago', { type: 'order', data: { id: 'ORD_MP_01' } });
  assert.equal(wh.paid, true);
  assert.equal(wh.alreadyPaid, false);
  assert.equal(wh.order.payment_method, 'debit');
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'active');

  const secondCheck = await gw.checkPointOrder(order.id);
  assert.equal(secondCheck.paid, true);
  assert.equal(secondCheck.alreadyPaid, true);
});

test('GatewayService.createCardPayment processa cartao transparente em 1x com valor do servidor e libera acesso', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST', mp_public_key: 'APP_USR_PUB_TEST' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));

  const plan = access.listPlans().find((p) => p.name === 'Mensal');
  const member = await access.createMember({
    name: 'Maria Cartao',
    document: '52998224725',
    phone: '62999993333',
    plan_id: plan.id,
  });

  let capturedPayment = null;
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, options) => {
      assert.equal(url, 'https://api.mercadopago.com/v1/payments');
      capturedPayment = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          id: 987654321,
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: capturedPayment.transaction_amount,
        }),
      };
    },
  });

  const res = await gw.createCardPayment({
    member_id: member.id,
    plan_id: plan.id,
    token: 'tok_test_123456',
    payment_method_id: 'visa',
    payer_email: 'maria@exemplo.com',
  });

  assert.equal(res.approved, true);
  assert.equal(res.external_id, '987654321');
  assert.equal(capturedPayment.installments, 1);
  assert.equal(capturedPayment.transaction_amount, Number((plan.price_cents / 100).toFixed(2)));
  assert.equal(capturedPayment.token, 'tok_test_123456');
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'active');
});

test('GatewayService.createPointOrder retorna statusCode 400 com mensagem real quando aluno nao tem plano ou Point retorna erro', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    mp_access_token: 'APP_USR_TEST',
    mp_point_terminal_id: 'PAX_A910__TEST',
  });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));

  const memberNoPlan = await access.createMember({
    name: 'Sem Plano',
    document: '52998224725',
    phone: '62999994444',
  });

  const plan = access.listPlans().find((p) => p.name === 'Mensal');
  const memberWithPlan = await access.createMember({
    name: 'Com Plano',
    document: '15350946056',
    phone: '62999995555',
    plan_id: plan.id,
  });

  const gw = new GatewayService(store, access, {
    fetchFn: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Terminal ocupado com outra cobrança em andamento.' }),
    }),
  });

  await assert.rejects(
    () => gw.createPointOrder({ member_id: memberNoPlan.id, payment_method: 'credit' }),
    (err) => err?.statusCode === 400 && /plano/i.test(err.message),
  );

  await assert.rejects(
    () => gw.createPointOrder({ member_id: memberWithPlan.id, payment_method: 'credit' }),
    (err) => err?.statusCode === 400 && /Terminal ocupado/i.test(err.message),
  );
});

test('Carrinho Point Smart: createPointOrder em lote soma valores e checkPointOrder da baixa em todos os alunos', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    mp_access_token: 'APP_USR_TEST',
    mp_point_terminal_id: 'NEWLAND_N950__TEST',
  });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.name === 'Mensal');

  const m1 = await access.createMember({
    name: 'Filha Um',
    document: '52998224725',
    phone: '62999991111',
    plan_id: plan.id,
  });
  const m2 = await access.createMember({
    name: 'Filha Dois',
    document: '15350946056',
    phone: '62999992222',
    plan_id: plan.id,
  });

  const expectedTotal = plan.price_cents * 2;
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, init = {}) => {
      if (url === 'https://api.mercadopago.com/v1/orders' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        assert.equal(body.transactions.payments[0].amount, (expectedTotal / 100).toFixed(2));
        return { ok: true, status: 201, json: async () => ({ id: 'ORD_BATCH_1', status: 'created' }) };
      }
      if (url === 'https://api.mercadopago.com/v1/orders/ORD_BATCH_1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ORD_BATCH_1',
            status: 'processed',
            transactions: {
              payments: [{ status: 'processed', amount: (expectedTotal / 100).toFixed(2), payment_method: { type: 'credit_card' } }],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const order = await gw.createPointOrder({
    items: [
      { member_id: m1.id, plan_id: plan.id, amount_cents: plan.price_cents },
      { member_id: m2.id, plan_id: plan.id, amount_cents: plan.price_cents },
    ],
    payment_method: 'credit',
  });
  assert.equal(order.amount_cents, expectedTotal);

  const check = await gw.checkPointOrder(order.id);
  assert.equal(check.paid, true);
  assert.equal(check.paymentResults.length, 2);
  assert.equal(access.getMember(m1.id).status, 'active');
  assert.equal(access.getMember(m2.id).status, 'active');
});

test('Assinatura Recorrente: evita duplicidade, processa webhook subscription_authorized_payment e syncActiveMpSubscriptions', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.duration_days === 30);
  const member = await access.createMember({
    name: 'Aluno Recorrente',
    document: '52998224725',
    phone: '62999990011',
    plan_id: plan.id,
  });

  let preapprovalCalls = 0;
  let extRef = '';
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, options = {}) => {
      if (url === 'https://api.mercadopago.com/preapproval') {
        preapprovalCalls += 1;
        const body = JSON.parse(options.body);
        extRef = body.external_reference;
        return {
          ok: true,
          json: async () => ({
            id: 'pre_dup_1',
            init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre_dup_1',
            status: 'pending',
          }),
        };
      }
      if (url === 'https://api.mercadopago.com/authorized_payments/auth_pay_99') {
        return {
          ok: true,
          json: async () => ({
            id: 'auth_pay_99',
            preapproval_id: 'pre_dup_1',
            external_reference: extRef,
          }),
        };
      }
      if (url === 'https://api.mercadopago.com/preapproval/pre_dup_1') {
        return {
          ok: true,
          json: async () => ({
            id: 'pre_dup_1',
            status: 'authorized',
            next_payment_date: '2026-12-25T10:00:00.000-03:00',
          }),
        };
      }
      if (url.startsWith('https://api.mercadopago.com/v1/payments/search')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 777001,
                status: 'approved',
                external_reference: extRef,
                transaction_amount: Number((plan.price_cents / 100).toFixed(2)),
                payment_type_id: 'credit_card',
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const s1 = await gw.createMpSubscription({ member_id: member.id, plan_id: plan.id });
  const s2 = await gw.createMpSubscription({ member_id: member.id, plan_id: plan.id });
  assert.equal(preapprovalCalls, 1, 'Não deve criar assinatura duplicada no Mercado Pago');
  assert.equal(s2.id, s1.id);
  assert.equal(s2.reused, true);

  const webhookRes = await gw.handleWebhook('mercadopago', {
    type: 'subscription_authorized_payment',
    data: { id: 'auth_pay_99' },
  });
  assert.equal(webhookRes.settledCount, 1);
  assert.equal(access.getMember(member.id).status, 'active');

  const syncBatch = await gw.syncActiveMpSubscriptions();
  assert.equal(syncBatch.checked, 1);
  assert.equal(syncBatch.settledCount, 0);
});

test('GatewayService.syncPendingCharges reconcilia cobranca checkout pendente e da baixa automatica', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.duration_days === 30);
  const member = await access.createMember({
    name: 'Thiago Teste',
    document: '52998224725',
    phone: '62986601004',
    plan_id: plan.id,
  });

  let createdRef = '';
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, options = {}) => {
      if (url === 'https://api.mercadopago.com/checkout/preferences') {
        const body = JSON.parse(options.body);
        createdRef = body.external_reference;
        assert.match(body.notification_url, /\/api\/webhooks\/mercadopago$/);
        return {
          ok: true,
          json: async () => ({ id: 'pref_sync_1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref_sync_1' }),
        };
      }
      if (url.startsWith('https://api.mercadopago.com/v1/payments/search')) {
        return {
          ok: true,
          json: async () => ({
            results: [{
              id: 190481223989,
              status: 'approved',
              currency_id: 'BRL',
              payment_method_id: 'pix',
              transaction_amount: Number((plan.price_cents / 100).toFixed(2)),
              external_reference: createdRef,
            }],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const charge = await gw.createCheckoutCharge({ member_id: member.id, plan_id: plan.id });
  assert.equal(charge.status, 'pending');

  const sync = await gw.syncPendingCharges();
  assert.equal(sync.checked, 1);
  assert.equal(sync.paidCount, 1);
  assert.equal(access.getMember(member.id).status, 'active');
});

test('Taxas separam maquininha, Pix online direto, Link/Checkout e assinatura conforme canal e metodo pago', async () => {
  const { calculatePaymentFee, resolvePaymentChannel } = await import('../src/services/feeUtils.js');
  const settings = {
    fee_point_debit_pct: '0.74',
    fee_point_credit_pct: '0.74',
    fee_point_pix_pct: '0',
    fee_online_pix_pct: '0.99',
    fee_online_credit_pct: '4.98',
    fee_checkout_pix_pct: '1.19',
    fee_checkout_credit_pct: '5.49',
    fee_checkout_debit_pct: '3.99',
    fee_subscription_credit_pct: '4.49',
  };

  assert.equal(resolvePaymentChannel({ external_id: 'point:123', notes: 'Point' }), 'point');
  assert.equal(resolvePaymentChannel({ external_id: 'mercadopago:123', notes: 'Pagamento online (Mercado Pago)' }), 'checkout');
  assert.equal(resolvePaymentChannel({ external_id: 'mercadopago:123', notes: 'Assinatura Mercado Pago (pre_1)' }), 'subscription');
  assert.equal(resolvePaymentChannel({ external_id: 'mercadopago:123', notes: 'Pix automático' }), 'online');

  assert.equal(calculatePaymentFee(10000, 'credit', settings, { channel: 'point' }).fee_cents, 74);
  assert.equal(calculatePaymentFee(10000, 'pix', settings, { channel: 'online' }).fee_cents, 99);
  assert.equal(calculatePaymentFee(10000, 'pix', settings, { channel: 'checkout' }).fee_cents, 119);
  assert.equal(calculatePaymentFee(10000, 'credit', settings, { channel: 'checkout' }).fee_cents, 549);
  assert.equal(calculatePaymentFee(10000, 'credit', settings, { channel: 'subscription' }).fee_cents, 449);
});

test('Point Smart suporta pagamento dividido em duas ordens (50 credito + 50 debito) e so libera acesso ao quitar o total', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    mp_point_access_token: 'APP_USR_POINT',
    mp_point_terminal_id: 'TERM_SPLIT_1',
  });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.duration_days === 30);
  const member = await access.createMember({
    name: 'Aluno Dividido POS',
    document: '52998224725',
    phone: '62999991111',
    plan_id: plan.id,
  });
  const openCharge = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  const halfCents = Math.floor(openCharge.amount / 2);
  const restCents = openCharge.amount - halfCents;

  let seq = 0;
  let lastOrderMethod = 'credit';
  let lastAmountStr = '0.00';
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, options = {}) => {
      if (url === 'https://api.mercadopago.com/v1/orders' && options.method === 'POST') {
        seq += 1;
        const body = JSON.parse(options.body);
        lastOrderMethod = body.config?.payment_method?.default_type === 'debit_card' ? 'debit' : 'credit';
        lastAmountStr = String(body.transactions?.payments?.[0]?.amount || '0.00');
        return {
          ok: true,
          json: async () => ({ id: `ORD_SPLIT_${seq}`, status: 'created' }),
        };
      }
      if (url.startsWith('https://api.mercadopago.com/v1/orders/ORD_SPLIT_')) {
        return {
          ok: true,
          json: async () => ({
            id: url.split('/').pop(),
            status: 'processed',
            transactions: {
              payments: [{ id: `PAY_${seq}`, status: 'processed', amount: lastAmountStr, payment_method: { type: `${lastOrderMethod}_card` } }],
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const o1 = await gw.createPointOrder({ member_id: member.id, plan_id: plan.id, amount_cents: halfCents, payment_method: 'credit' });
  const r1 = await gw.checkPointOrder(o1.id);
  assert.equal(r1.paid, true);
  assert.equal(r1.partial, true);
  assert.equal(r1.remaining_cents, restCents);
  assert.equal(access.getMember(member.id).status, 'pending');

  const o2 = await gw.createPointOrder({ member_id: member.id, plan_id: plan.id, amount_cents: restCents, payment_method: 'debit' });
  const r2 = await gw.checkPointOrder(o2.id);
  assert.equal(r2.paid, true);
  assert.equal(Boolean(r2.partial), false);
  assert.equal(access.getMember(member.id).status, 'active');

  const pays = store.all('SELECT method, amount_cents FROM payments WHERE member_id = ? ORDER BY id ASC', [member.id]);
  assert.equal(pays.length, 2);
  assert.deepEqual(pays.map((p) => [p.method, p.amount_cents]), [['credit', halfCents], ['debit', restCents]]);
});

test('getMpNotificationUrl retorna /api/webhooks/mercadopago e createPixCharge diferencia amount_cents', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST', portal_url: 'https://academia.exemplo.com/' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.duration_days === 30);
  const member = await access.createMember({ name: 'Aluno Pix Diff', document: '52998224725', plan_id: plan.id });

  let seq = 100;
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, opts = {}) => {
      if (url.endsWith('/v1/payments') && opts.method === 'POST') {
        const currentId = ++seq;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: currentId,
            point_of_interaction: { transaction_data: { qr_code: `QR_${currentId}`, qr_code_base64: 'AA==', ticket_url: `https://mp/${currentId}` } },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(gw.getMpNotificationUrl(), 'https://academia.exemplo.com/api/webhooks/mercadopago');

  const [p50, p80] = await Promise.all([
    gw.createPixCharge({ member_id: member.id, amount_cents: 5000 }),
    gw.createPixCharge({ member_id: member.id, amount_cents: 8000 }),
  ]);
  assert.equal(p50.amount_cents, 5000);
  assert.equal(p80.amount_cents, 8000);
  assert.notEqual(p50.external_id, p80.external_id);

  const p50Again = await gw.createPixCharge({ member_id: member.id, amount_cents: 5000 });
  assert.equal(p50Again.id, p50.id);
});

test('_settleChargeOnce quita cobranca com desconto sem 409 e faz rollback atomico em batchItems', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.price_cents === 12000);
  const member = await access.createMember({ name: 'Aluno Desconto', document: '52998224725', plan_id: plan.id });
  const openCharge = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  assert.equal(openCharge.amount, 12000);

  const gw = new GatewayService(store, access);
  const ins = store.run(
    `INSERT INTO gateway_charges (provider, external_id, member_id, plan_id, amount_cents, status, membership_charge_id)
     VALUES ('mercadopago', 'EXT_DESC_1', ?, ?, 9000, 'pending', ?)`,
    [member.id, plan.id, openCharge.id],
  );
  const gc = store.get('SELECT * FROM gateway_charges WHERE id = ?', [ins.lastInsertRowid]);
  const settled = await gw.settleCharge(gc, { paymentId: 'EXT_DESC_1', method: 'pix' });
  assert.equal(settled.alreadyPaid, false);
  assert.equal(settled.paymentResult.payment.amount_cents, 9000);
  assert.ok(store.get('SELECT payment_id FROM membership_charges WHERE id = ?', [openCharge.id]).payment_id);

  // Batch com item invalido nao pode deixar item 1 pago
  const m2 = await access.createMember({ name: 'Aluno Lote Ok', document: '39053344705', plan_id: plan.id });
  const batchIns = store.run(
    `INSERT INTO gateway_charges (provider, external_id, member_id, plan_id, amount_cents, status, batch_items_json)
     VALUES ('mercadopago', 'EXT_BATCH_FAIL', ?, ?, 24000, 'pending', ?)`,
    [
      m2.id,
      plan.id,
      JSON.stringify([
        { member_id: m2.id, plan_id: plan.id, amount_cents: 12000 },
        { member_id: 999999, plan_id: plan.id, amount_cents: 12000 },
      ]),
    ],
  );
  const batchGc = store.get('SELECT * FROM gateway_charges WHERE id = ?', [batchIns.lastInsertRowid]);
  await assert.rejects(() => gw.settleCharge(batchGc, { paymentId: 'EXT_BATCH_FAIL', method: 'pix' }));
  assert.equal(store.all('SELECT id FROM payments WHERE member_id = ?', [m2.id]).length, 0);
  assert.equal(store.get('SELECT status FROM gateway_charges WHERE id = ?', [batchGc.id]).status, 'pending');
});

test('_markPointOrderPaid registra cash_movements e whatsapp na parcela parcial e protege batchItems', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', mp_access_token: 'APP_USR_TEST', mp_point_terminal_id: 'TERM_1' });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.price_cents === 12000);
  const member = await access.createMember({ name: 'Aluno Parcial Caixa', document: '52998224725', phone: '62999990000', plan_id: plan.id });
  const openCharge = store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL', [member.id]);
  store.run("INSERT INTO cash_sessions (opening_cents, status) VALUES (10000, 'open')");

  const enqueued = [];
  const gw = new GatewayService(store, access, {
    whatsappService: {
      enqueuePaymentReceipt: async (res) => { enqueued.push(res.payment.id); },
    },
  });

  const ordIns = store.run(
    `INSERT INTO point_orders (order_id, terminal_id, member_id, plan_id, amount_cents, payment_method, status, membership_charge_id, provider)
     VALUES ('ORD_PARTIAL_1', 'TERM_1', ?, ?, 5000, 'credit', 'pending', ?, 'mercadopago')`,
    [member.id, plan.id, openCharge.id],
  );
  const ord = gw.getPointOrderById(ordIns.lastInsertRowid);
  const res = await gw._markPointOrderPaid(ord, 'credit', 'mp_order:ORD_PARTIAL_1', 'Point Smart');
  assert.equal(res.partial, true);
  assert.equal(enqueued.length, 1);
  const movements = store.all("SELECT * FROM cash_movements WHERE type = 'payment'");
  assert.equal(movements.length, 1);
  assert.equal(movements[0].amount_cents, 5000);

  // Batch com erro no 2o item nao marca point_orders como paid nem grava 1o item
  const m2 = await access.createMember({ name: 'Aluno Carrinho Ok', document: '39053344705', plan_id: plan.id });
  const batchOrdIns = store.run(
    `INSERT INTO point_orders (order_id, terminal_id, member_id, plan_id, amount_cents, payment_method, status, provider, batch_items_json)
     VALUES ('ORD_BATCH_FAIL', 'TERM_1', ?, ?, 24000, 'credit', 'pending', 'mercadopago', ?)`,
    [
      m2.id,
      plan.id,
      JSON.stringify([
        { member_id: m2.id, plan_id: plan.id, amount_cents: 12000 },
        { member_id: 999999, plan_id: plan.id, amount_cents: 12000 },
      ]),
    ],
  );
  const batchOrd = gw.getPointOrderById(batchOrdIns.lastInsertRowid);
  await assert.rejects(() => gw._markPointOrderPaid(batchOrd, 'credit', 'mp_order:ORD_BATCH_FAIL', 'Point Smart'));
  assert.equal(gw.getPointOrderById(batchOrd.id).status, 'pending');
  assert.equal(store.all('SELECT id FROM payments WHERE member_id = ?', [m2.id]).length, 0);
});

test('Stone POS: bloqueia carrinho, valida reutilizacao de pendente, valida valor em checkPointOrder e metodo em webhook', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    controlid_mock_mode: 'true',
    pos_provider: 'stone',
    stone_api_key: 'sk_test_stone',
    stone_terminal_serial: 'SN_STONE_1',
  });
  const access = new AccessService(store, new ControlIdClient(() => store.getSettings()));
  const plan = access.listPlans().find((p) => p.price_cents === 12000);
  const member = await access.createMember({ name: 'Aluno Stone', document: '52998224725', plan_id: plan.id });

  let orderSeq = 0;
  let stoneCheckResponse = { status: 'paid', charges: [{ payment_method: 'debit_card', last_transaction: { amount: 99999 } }] };
  const gw = new GatewayService(store, access, {
    fetchFn: async (url, opts = {}) => {
      if (url === 'https://api.pagar.me/core/v5/orders' && opts.method === 'POST') {
        orderSeq += 1;
        return { ok: true, json: async () => ({ id: `or_stone_${orderSeq}` }) };
      }
      if (url.startsWith('https://api.pagar.me/core/v5/orders/or_stone_')) {
        return { ok: true, json: async () => stoneCheckResponse };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await assert.rejects(
    () => gw.createPointOrder({ provider: 'stone', items: [{ member_id: member.id }] }),
    (err) => err.statusCode === 400 && /Point Smart Mercado Pago/i.test(err.message),
  );

  const o1 = await gw.createPointOrder({ member_id: member.id, provider: 'stone', payment_method: 'credit', terminal_id: 'SN_STONE_1' });
  const o1Same = await gw.createPointOrder({ member_id: member.id, provider: 'stone', payment_method: 'credit', terminal_id: 'SN_STONE_1' });
  assert.equal(o1Same.id, o1.id);

  // Metodo diferente cria nova ordem
  const o2 = await gw.createPointOrder({ member_id: member.id, provider: 'stone', payment_method: 'debit', terminal_id: 'SN_STONE_1' });
  assert.notEqual(o2.id, o1.id);

  // Valor divergente no checkPointOrder lanca 400
  await assert.rejects(
    () => gw.checkPointOrder(o2.id),
    (err) => err.statusCode === 400 && /difere da cobrança/i.test(err.message),
  );

  // Webhook Stone le payment_method de data.charges[0].payment_method
  const wh = await gw.handleStoneWebhook({
    type: 'order.paid',
    data: {
      id: o2.order_id,
      amount: 12000,
      charges: [{ amount: 12000, payment_method: 'debit_card' }],
    },
  });
  assert.equal(wh.paid, true);
  assert.equal(wh.paymentResult.payment.method, 'debit');
});
