// --- Financeiro: DRE, Despesas, Comissões e Cobrança Automática ---
async function loadFinanceSection(month) {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  const [dre, expenses, commissions] = await Promise.all([
    api(`/api/finance/dre${qs}`).catch(() => null),
    api(`/api/finance/expenses${qs}`).catch(() => []),
    api('/api/finance/commissions').catch(() => []),
  ]);

  if (dre) {
    document.getElementById('dreRevenue').textContent = fmtMoney(dre.revenue_cents);
    document.getElementById('dreExpensesPaid').textContent = fmtMoney(dre.expenses_paid_cents);
    document.getElementById('dreExpensesPending').textContent = fmtMoney(dre.expenses_pending_cents);
    const netEl = document.getElementById('dreNetProfit');
    netEl.textContent = fmtMoney(dre.net_profit_cents);
    netEl.className = `card-value ${dre.net_profit_cents < 0 ? 'text-danger' : 'text-success'}`;
  }

  const expBody = document.getElementById('expensesBody');
  if (expBody) {
    expBody.innerHTML = expenses.length
      ? expenses.map((ex) => `<tr>
          <td>${escapeHtml(ex.description)}</td>
          <td>${escapeHtml(ex.category)}</td>
          <td>${escapeHtml(fmtDate(ex.due_date))}</td>
          <td>${fmtMoney(ex.amount_cents)}</td>
          <td><span class="badge ${ex.status === 'paid' ? 'badge-active' : 'badge-pending'}">${ex.status === 'paid' ? 'Pago' : 'Pendente'}</span></td>
          <td class="inline-actions">
            ${ex.status !== 'paid' ? `<button type="button" class="btn btn-success btn-sm" data-pay-expense="${ex.id}">Pagar</button>` : ''}
            <button type="button" class="btn btn-danger btn-sm" data-del-expense="${ex.id}">Excluir</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-cell">Nenhuma despesa lançada.</td></tr>';
  }

  const commBody = document.getElementById('commissionsBody');
  if (commBody) {
    commBody.innerHTML = commissions.length
      ? commissions.map((c) => `<tr>
          <td>${escapeHtml(c.staff_name)}</td>
          <td>${escapeHtml(c.source_type)}</td>
          <td>${fmtMoney(c.amount_cents)}</td>
          <td><span class="badge ${c.status === 'paid' ? 'badge-active' : 'badge-pending'}">${c.status === 'paid' ? 'Paga' : 'Pendente'}</span></td>
          <td>${c.status !== 'paid' ? `<button type="button" class="btn btn-success btn-sm" data-pay-commission="${c.id}">Pagar</button>` : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty-cell">Nenhuma comissão registrada.</td></tr>';
  }
}

document.getElementById('expenseForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/finance/expenses', {
        method: 'POST',
        body: JSON.stringify({
          description: document.getElementById('expDesc').value.trim(),
          category: document.getElementById('expCategory').value.trim() || 'geral',
          amount_cents: toCents(document.getElementById('expAmount').value),
          due_date: document.getElementById('expDueDate').value,
          notes: document.getElementById('expNotes').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Despesa lançada.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('expensesBody')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-expense]');
  if (payBtn) {
    await withLoading(payBtn, async () => {
      try {
        await api(`/api/finance/expenses/${payBtn.dataset.payExpense}/pay`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Despesa marcada como paga.');
        await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const delBtn = e.target.closest('[data-del-expense]');
  if (delBtn && window.confirm('Excluir esta despesa?')) {
    await withLoading(delBtn, async () => {
      try {
        await api(`/api/finance/expenses/${delBtn.dataset.delExpense}`, { method: 'DELETE' });
        showToast('Despesa excluída.');
        await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

document.getElementById('commissionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/finance/commissions', {
        method: 'POST',
        body: JSON.stringify({
          staff_name: document.getElementById('commStaffName').value.trim(),
          source_type: document.getElementById('commSourceType').value,
          amount_cents: toCents(document.getElementById('commAmount').value),
          description: document.getElementById('commDesc').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Comissão lançada.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('commissionsBody')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-commission]');
  if (!payBtn) return;
  await withLoading(payBtn, async () => {
    try {
      await api(`/api/finance/commissions/${payBtn.dataset.payCommission}/pay`, { method: 'POST' });
      showToast('Comissão paga.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnAutoCollection')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/finance/auto-collection', { method: 'POST' });
      showToast(`Cobrança automática executada: ${res.queued ?? 0} mensagem(ns) enfileirada(s).`);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});


// --- Pagamento Dividido & Débitos em Aberto ---
function getActiveMethodsForSplit() {
  return (state.paymentMethods || []).filter((pm) => pm.active);
}

function addSplitRow(preferredCode = null, amountValue = '') {
  const container = document.getElementById('pSplitRows');
  if (!container) return;
  const methods = getActiveMethodsForSplit();
  const optionsHtml = methods
    .map((pm) => `<option value="${escapeHtml(pm.code)}" ${pm.code === preferredCode ? 'selected' : ''}>${escapeHtml(pm.name)}</option>`)
    .join('');
  const row = document.createElement('div');
  row.className = 'split-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 120px auto auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <select class="split-method" aria-label="Forma de pagamento">${optionsHtml}</select>
    <input type="number" min="0" step="0.01" class="split-amount" placeholder="0,00" value="${escapeHtml(amountValue)}" aria-label="Valor nesta forma (R$)" />
    <button type="button" class="btn btn-secondary btn-sm split-send-point" title="Enviar este valor para a maquininha">Maquininha</button>
    <button type="button" class="btn btn-secondary btn-sm split-remove" title="Remover forma" aria-label="Remover forma">&times;</button>
  `;
  container.appendChild(row);
}

function resetSplitBox() {
  const container = document.getElementById('pSplitRows');
  if (container) {
    container.innerHTML = '';
    const methods = getActiveMethodsForSplit();
    const first = methods.find((m) => m.code === 'cash')?.code || methods[0]?.code || 'cash';
    const second = methods.find((m) => m.code === 'pix')?.code || methods[1]?.code || first;
    addSplitRow(first);
    addSplitRow(second);
  }
  const debtInput = document.getElementById('pDebtAmount');
  if (debtInput) debtInput.value = '0';
  const debtDate = document.getElementById('pDebtDueDate');
  if (debtDate) debtDate.value = '';
}

function readSplitState() {
  const rows = [...document.querySelectorAll('#pSplitRows .split-row')];
  const splitPayments = rows
    .map((row) => ({
      method: row.querySelector('.split-method')?.value || '',
      amount_cents: toCents(row.querySelector('.split-amount')?.value || 0),
    }))
    .filter((item) => item.amount_cents > 0);
  const debtCents = toCents(document.getElementById('pDebtAmount')?.value || 0);
  const paidCents = splitPayments.reduce((acc, item) => acc + item.amount_cents, 0);
  return { splitPayments, debtCents, paidCents, totalCoveredCents: paidCents + debtCents };
}

function syncSplitSummary(targetNetCents) {
  const summaryEl = document.getElementById('pSplitSummary');
  const { paidCents, debtCents, totalCoveredCents } = readSplitState();
  const remaining = Number(targetNetCents || 0) - totalCoveredCents;
  if (summaryEl) {
    summaryEl.textContent = `Pago agora: ${fmtMoney(paidCents)} · Saldo pendente (fiado): ${fmtMoney(debtCents)} · Restante: ${fmtMoney(remaining)}`;
    summaryEl.style.color = remaining === 0 ? 'var(--success)' : 'var(--danger, #f87171)';
  }
  return remaining;
}

document.getElementById('pSplitToggle')?.addEventListener('change', (e) => {
  if (e.target.checked && !document.querySelectorAll('#pSplitRows .split-row').length) {
    resetSplitBox();
  }
  renderBillingSummary();
});

document.getElementById('btnAddSplitRow')?.addEventListener('click', () => {
  addSplitRow();
  renderBillingSummary();
});

document.getElementById('pSplitRows')?.addEventListener('input', () => renderBillingSummary());
document.getElementById('pSplitRows')?.addEventListener('change', () => renderBillingSummary());
document.getElementById('pSplitRows')?.addEventListener('click', async (e) => {
  const sendPoint = e.target.closest('.split-send-point');
  if (sendPoint) {
    const memberId = document.getElementById('pMember').value;
    if (!memberId) {
      showToast('Selecione o aluno primeiro.', true);
      document.getElementById('pMemberSearch')?.focus();
      return;
    }
    const row = sendPoint.closest('.split-row');
    const amountCents = toCents(row?.querySelector('.split-amount')?.value || 0);
    if (amountCents <= 0) {
      showToast('Informe um valor válido nesta linha para enviar à maquininha.', true);
      row?.querySelector('.split-amount')?.focus();
      return;
    }
    const paymentMethod = row?.querySelector('.split-method')?.value || 'credit';
    const planId = document.getElementById('pPlan').value || null;
    await withLoading(sendPoint, async () => {
      try {
        const order = await api('/api/gateways/mp/point-orders', {
          method: 'POST',
          body: JSON.stringify({ member_id: memberId, plan_id: planId, amount_cents: amountCents, payment_method: paymentMethod }),
        });
        showToast(`Cobrança de ${fmtMoney(amountCents)} enviada para a maquininha!`);
        await loadPointOrders();
        if (order?.id) startPaymentAutoPoll({ type: 'point', id: order.id, stayOnMember: true });
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const rm = e.target.closest('.split-remove');
  if (!rm) return;
  const rows = document.querySelectorAll('#pSplitRows .split-row');
  if (rows.length <= 1) {
    rm.closest('.split-row').querySelector('.split-amount').value = '';
  } else {
    rm.closest('.split-row').remove();
  }
  renderBillingSummary();
});

document.getElementById('pDebtAmount')?.addEventListener('input', () => renderBillingSummary());

document.getElementById('btnRestToDebt')?.addEventListener('click', () => {
  const member = state.allMembers.find((entry) => entry.id === Number(document.getElementById('pMember').value));
  const charge = member?.next_charge;
  const baseAmount = charge?.amount ?? toCents(document.getElementById('pAmount').value);
  const creditCents = Number(member?.credit_cents || 0);
  const useCredit = Boolean(document.getElementById('pUseCredit')?.checked);
  const creditUsed = member && creditCents > 0 && useCredit ? Math.min(creditCents, baseAmount) : 0;
  const netTarget = Math.max(0, baseAmount - creditUsed);
  const { paidCents } = readSplitState();
  const restCents = Math.max(0, netTarget - paidCents);
  const debtInput = document.getElementById('pDebtAmount');
  if (debtInput) debtInput.value = (restCents / 100).toFixed(2);
  renderBillingSummary();
});

async function loadOpenDebts() {
  const container = document.getElementById('openDebtsQueue');
  if (!container) return;
  const debts = await api('/api/debts?status=open');
  state.openDebts = debts;
  container.innerHTML = debts.length
    ? debts.map((d) => `
      <div class="billing-member" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;cursor:default;">
        <div class="billing-member-main">
          <strong>${escapeHtml(d.member_name)}</strong>
          <span class="billing-member-meta">Saldo pendente (fiado): <strong>${fmtMoney(d.remaining_cents)}</strong>${d.due_date ? ` · Venc. ${escapeHtml(fmtDate(d.due_date))}` : ''}${d.notes ? ` · ${escapeHtml(d.notes)}` : ''}</span>
        </div>
        <div class="inline-actions billing-member-cta">
          <button type="button" class="btn btn-primary btn-sm" data-pay-debt="${d.id}">Receber</button>
          <button type="button" class="btn btn-secondary btn-sm" data-cancel-debt="${d.id}">Cancelar</button>
        </div>
      </div>
    `).join('')
    : '<p class="muted">Nenhum saldo pendente (fiado) em aberto.</p>';
}

document.getElementById('openDebtsQueue')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-debt]');
  if (payBtn) {
    const id = Number(payBtn.dataset.payDebt);
    const debt = (state.openDebts || []).find((d) => d.id === id);
    if (!debt) return;
    document.getElementById('debtPayId').value = String(debt.id);
    document.getElementById('debtPayAmount').value = (Number(debt.remaining_cents) / 100).toFixed(2);
    document.getElementById('debtPayAmount').max = (Number(debt.remaining_cents) / 100).toFixed(2);
    document.getElementById('debtPayNotes').value = '';
    document.getElementById('debtPayInfo').textContent = `${debt.member_name} · Saldo pendente (fiado): ${fmtMoney(debt.remaining_cents)}`;
    document.getElementById('debtPayModal')?.showModal();
    return;
  }
  const cancelBtn = e.target.closest('[data-cancel-debt]');
  if (cancelBtn) {
    const id = Number(cancelBtn.dataset.cancelDebt);
    if (!window.confirm('Cancelar este saldo pendente (fiado) em aberto?')) return;
    await withLoading(cancelBtn, async () => {
      try {
        const res = await api(`/api/debts/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Saldo pendente cancelado.');
        if (res?.member) patchMemberInState(res.member);
        loadOpenDebts().catch(() => {});
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

document.getElementById('btnCloseDebtPayModal')?.addEventListener('click', () => {
  document.getElementById('debtPayModal')?.close();
});

document.getElementById('debtPayForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = Number(document.getElementById('debtPayId').value);
  await withLoading(e.target, async () => {
    try {
      const res = await api(`/api/debts/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          amount_cents: toCents(document.getElementById('debtPayAmount').value),
          method: document.getElementById('debtPayMethod').value,
          notes: document.getElementById('debtPayNotes').value.trim() || null,
        }),
      });
      document.getElementById('debtPayModal')?.close();
      showToast('Saldo pendente recebido com sucesso!');
      if (res?.member) patchMemberInState(res.member);
      Promise.allSettled([loadOpenDebts(), loadPayments(), loadDashboard(), tabRequests.has('cash') ? loadCash() : loadCurrentCash()]).catch(() => {});
      if (state.selectedProfileId && !document.getElementById('profileModal')?.classList.contains('hidden')) {
        await loadMemberOpenDebts(state.selectedProfileId);
      }
    } catch (err) {
      if (err.code === 'CASH_CLOSED') {
        document.getElementById('debtPayModal')?.close();
        await openCashFromBilling();
      } else {
        showToast(err.message, true);
      }
    }
  });
});

