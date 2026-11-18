import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { GymService } from '../src/services/gymService.js';
import { AccessService } from '../src/services/accessService.js';
import { GatewayService } from '../src/services/gatewayService.js';

test('Stone Smart POS: createPointOrder envia para Pagar.me v5 e handleStoneWebhook da baixa automatica', async () => {
  const store = await DatabaseStore.create(null);
  const access = new AccessService(store);

  const plan = access.createPlan({ name: 'Mensal Stone', duration_days: 30, price_cents: 12000 });
  const member = await access.createMember({
    name: 'Carlos Stone',
    document: '52998224725',
    phone: '62999991111',
    plan_id: plan.id,
    status: 'pending',
  });

  store.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('pos_provider', 'stone')");
  store.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('stone_api_key', 'sk_test_123')");
  store.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('stone_terminal_serial', '6L123456')");

  const requests = [];
  const fetchFn = async (url, opts) => {
    requests.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ id: 'or_stone_999', status: 'pending' });
      },
    };
  };

  const gateway = new GatewayService(store, access, { fetchFn });
  const order = await gateway.createPointOrder({ member_id: member.id, plan_id: plan.id, payment_method: 'credit' });

  assert.equal(order.provider, 'stone');
  assert.equal(order.order_id, 'or_stone_999');
  assert.equal(order.terminal_id, '6L123456');
  assert.equal(requests[0].url, 'https://api.pagar.me/core/v5/orders');
  assert.deepEqual(requests[0].body.poi_payment_settings.devices_serial_number, ['6L123456']);

  const webhookRes = await gateway.handleStoneWebhook({
    type: 'charge.paid',
    data: {
      id: 'ch_123',
      status: 'paid',
      payment_method: 'debit_card',
      order: { id: 'or_stone_999' },
    },
  });

  assert.equal(webhookRes.paid, true);
  assert.equal(webhookRes.order.status, 'paid');
  const updatedMember = access.getMember(member.id);
  assert.equal(updatedMember.status, 'active');
});
