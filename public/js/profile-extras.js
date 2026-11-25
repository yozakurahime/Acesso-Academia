// --- Crédito do Aluno ---
document.getElementById('pUseCredit')?.addEventListener('change', renderBillingSummary);

function renderMemberCredit({ credit_cents = 0, logs = [] }) {
  document.getElementById('profCreditBalance').textContent = `Saldo: ${fmtMoney(credit_cents)}`;
  const kpiCreditEl = document.getElementById('profKpiCredit');
  if (kpiCreditEl) kpiCreditEl.textContent = fmtMoney(credit_cents);
  document.getElementById('profCreditLogsList').innerHTML = logs.length
    ? logs.slice(0, 8).map((l) => {
        const sign = l.delta_cents >= 0 ? '+' : '-';
        return `<li>${escapeHtml(fmtDateTime(l.created_at))} · <strong>${sign}${fmtMoney(Math.abs(l.delta_cents))}</strong> (Saldo: ${fmtMoney(l.balance_after_cents)}) — ${escapeHtml(l.reason || '')}</li>`;
      }).join('')
    : '<li class="muted">Nenhuma movimentação de crédito.</li>';
}

async function loadMemberCredit(memberId) {
  const data = await api(`/api/members/${memberId}/credit`);
  renderMemberCredit(data);
}

document.getElementById('creditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedProfileId) return;
  await withLoading(e.target, async () => {
    try {
      const data = await api(`/api/members/${state.selectedProfileId}/credit`, {
        method: 'POST',
        body: JSON.stringify({
          type: document.getElementById('creditType').value,
          amount_cents: toCents(document.getElementById('creditAmount').value),
          reason: document.getElementById('creditReason').value.trim(),
        }),
      });
      e.target.reset();
      renderMemberCredit(data);
      showToast(`Crédito atualizado! Saldo: ${fmtMoney(data.credit_cents)}`);
      patchMemberInState({ id: state.selectedProfileId, credit_cents: data.credit_cents });
      if (Number(document.getElementById('pMember').value) === Number(state.selectedProfileId)) {
        renderBillingSummary();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

attachCpfValidation('mDoc', 'mDocFeedback', () => 0);
attachCpfValidation('stDoc', 'stDocFeedback', () => 0);
attachCpfValidation('profDoc', 'profDocFeedback', () => state.selectedProfileId || 0);

// --- Visitante / Day Use ---
document.getElementById('visitorForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/visitors', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('visName').value.trim(),
          document: document.getElementById('visDoc').value.trim() || null,
          phone: document.getElementById('visPhone').value.trim() || null,
          valid_until: document.getElementById('visValidUntil').value || null,
        }),
      });
      e.target.reset();
      const id = res.visitor?.id;
      showToast(res.sync?.synced === false
        ? `Visitante #${id} criado. Aviso catraca: ${res.sync.error}`
        : `Visitante #${id} liberado!`);
      if (res.visitor) patchMemberInState(res.visitor);
      else loadMembers().catch(() => {});
      loadDashboard().catch(() => {});
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Trancamento, Contrato/PAR-Q e Avaliação Física (Perfil do Aluno) ---
document.getElementById('freezeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const rawDays = document.getElementById('freezeDays').value.trim();
  const reason = document.getElementById('freezeReason').value.trim() || null;
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/freeze`, {
        method: 'POST',
        body: JSON.stringify({
          days: rawDays ? Number(rawDays) : null,
          reason,
        }),
      });
      showToast('Matrícula trancada.');
      if (!patchMemberInState(res.member || { id, frozen_until: res.frozen_until, frozen_reason: reason })) {
        await loadMembers();
      }
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnUnfreezeMember')?.addEventListener('click', async (e) => {
  const id = state.selectedProfileId;
  if (!id) return;
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/unfreeze`, { method: 'POST' });
      showToast(`Matrícula destrancada (+${res.extendedDays || 0} dia(s) estendidos).`);
      if (!patchMemberInState(res.member || { id, frozen_until: null, frozen_reason: null })) {
        await loadMembers();
      }
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('contractForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const signature = document.getElementById('contractSignature').value.trim();
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/contract`, {
        method: 'POST',
        body: JSON.stringify({ signature }),
      });
      showToast('PAR-Q e Contrato assinados!');
      patchMemberInState(res.member || { id, contract_signed_at: new Date().toISOString(), contract_signature: signature });
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadMemberAssessments(memberId) {
  const listEl = document.getElementById('profAssessmentsList');
  if (!listEl) return;
  const rows = await api(`/api/members/${memberId}/assessments`).catch(() => []);
  listEl.innerHTML = rows.length
    ? rows.map((a) => {
        const metrics = [
          a.weight_kg != null ? `${a.weight_kg} kg` : '',
          a.height_cm != null ? `${a.height_cm} cm` : '',
          a.body_fat_pct != null ? `${a.body_fat_pct}% gord.` : '',
          a.muscle_mass_kg != null ? `${a.muscle_mass_kg} kg magra` : '',
          a.waist_cm != null ? `Cintura ${a.waist_cm} cm` : '',
        ].filter(Boolean).join(' · ');
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <span><strong>${escapeHtml(fmtDate(a.assessed_at))}</strong> — ${escapeHtml(metrics || 'Sem medidas')}${a.notes ? ` · ${escapeHtml(a.notes)}` : ''}</span>
          <button type="button" class="btn btn-danger btn-sm" data-delete-assessment="${a.id}">Excluir</button>
        </li>`;
      }).join('')
    : '<li class="muted">Nenhuma avaliação física registrada.</li>';
}

document.getElementById('assessmentForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const num = (elId) => {
    const v = document.getElementById(elId)?.value;
    return v === '' || v == null ? null : Number(v);
  };
  await withLoading(e.currentTarget, async () => {
    try {
      await api(`/api/members/${id}/assessments`, {
        method: 'POST',
        body: JSON.stringify({
          weight_kg: num('assWeight'),
          height_cm: num('assHeight'),
          body_fat_pct: num('assBodyFat'),
          muscle_mass_kg: num('assMuscle'),
          waist_cm: num('assWaist'),
          notes: document.getElementById('assNotes').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Avaliação física salva!');
      await loadMemberAssessments(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('profAssessmentsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-assessment]');
  if (!btn || !window.confirm('Excluir esta avaliação física?')) return;
  await withLoading(btn, async () => {
    try {
      await api(`/api/assessments/${btn.dataset.deleteAssessment}`, { method: 'DELETE' });
      showToast('Avaliação excluída.');
      if (state.selectedProfileId) await loadMemberAssessments(state.selectedProfileId);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});


// ===== PROFILE MODAL TABS, OPEN DEBTS & QUICK TEMPLATE =====
function activateProfileTab(tabName = 'personal') {
  document.querySelectorAll('#profileTabs .profile-tab-btn').forEach((btn) => {
    const isActive = btn.dataset.profTab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('#profileModal [data-prof-tab-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.profTabPanel !== tabName);
  });
  const m = state.selectedProfileMember;
  if (!m || m.access_role !== 'student') return;
  if (!state.profileLoadedTabs) state.profileLoadedTabs = new Set();
  if (tabName === 'workouts' && !state.profileLoadedTabs.has('workouts')) {
    state.profileLoadedTabs.add('workouts');
    Promise.all([loadMemberWorkouts(m.id), loadWorkoutTemplates().catch(() => {})]).catch(() => {});
  } else if (tabName === 'assessments' && !state.profileLoadedTabs.has('assessments')) {
    state.profileLoadedTabs.add('assessments');
    loadMemberAssessments(m.id).catch(() => {});
  }
}

document.getElementById('profileTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.profile-tab-btn[data-prof-tab]');
  if (!btn || btn.classList.contains('hidden')) return;
  activateProfileTab(btn.dataset.profTab);
});

async function loadMemberOpenDebts(memberId) {
  const listEl = document.getElementById('profOpenDebtsList');
  const totalEl = document.getElementById('profOpenDebtsTotal');
  const kpiDebtEl = document.getElementById('profKpiDebt');
  const badgeEl = document.getElementById('profDebtsCountBadge');
  if (!listEl) return;
  try {
    const debts = await api(`/api/members/${memberId}/debts?status=open`);
    const charges = state.selectedProfileOpenCharges || [];
    state.selectedProfileDebts = debts;
    const totalCents = debts.reduce((sum, d) => sum + Number(d.remaining_cents || 0), 0)
      + charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const openCount = debts.length + charges.length;
    if (totalEl) totalEl.textContent = fmtMoney(totalCents);
    if (kpiDebtEl) kpiDebtEl.textContent = fmtMoney(totalCents);
    if (badgeEl) {
      badgeEl.textContent = String(openCount);
      badgeEl.classList.toggle('hidden', openCount === 0);
    }
    const chargesHtml = charges.map((c) => `
      <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${fmtMoney(c.amount)}</strong>
          <span class="badge badge-pending" style="margin-left:6px;">Em aberto</span>
          <span class="muted"> · Mensalidade do plano · Venc. ${escapeHtml(fmtDate(c.due))}</span>
        </div>
        <div class="inline-actions" style="gap:6px;">
          <button type="button" class="btn btn-primary btn-sm" data-prof-pay-charge="${c.id}">Receber</button>
          <button type="button" class="btn btn-danger btn-sm" data-prof-cancel-charge="${c.id}">Remover</button>
        </div>
      </li>
    `).join('');
    const debtsHtml = debts.map((d) => `
      <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${fmtMoney(d.remaining_cents)}</strong>
          <span class="muted">${d.due_date ? ` · Venc. ${escapeHtml(fmtDate(d.due_date))}` : ''}${d.notes ? ` · ${escapeHtml(d.notes)}` : ''}</span>
        </div>
        <div class="inline-actions" style="gap:6px;">
          <button type="button" class="btn btn-primary btn-sm" data-prof-pay-debt="${d.id}">Receber</button>
          <button type="button" class="btn btn-secondary btn-sm" data-prof-cancel-debt="${d.id}">Cancelar</button>
        </div>
      </li>
    `).join('');
    listEl.innerHTML = (chargesHtml + debtsHtml) || '<li class="muted">Nenhuma conta em aberto.</li>';
  } catch (err) {
    listEl.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
  }
}

document.getElementById('profOpenDebtsList')?.addEventListener('click', async (e) => {
  const cancelChargeBtn = e.target.closest('[data-prof-cancel-charge]');
  if (cancelChargeBtn) {
    const id = Number(cancelChargeBtn.dataset.profCancelCharge);
    if (!window.confirm('Remover esta cobrança em aberto?')) return;
    await withLoading(cancelChargeBtn, async () => {
      try {
        await api(`/api/membership-charges/${id}`, { method: 'DELETE' });
        showToast('Cobrança removida.');
        if (state.selectedProfileId) {
          await openProfile(state.selectedProfileId);
          patchMemberInState({
            id: state.selectedProfileId,
            next_charge: state.selectedProfileOpenCharges?.[0] || null,
          });
        }
        loadDashboard().catch(() => {});
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const cancelDebtBtn = e.target.closest('[data-prof-cancel-debt]');
  if (cancelDebtBtn) {
    const id = Number(cancelDebtBtn.dataset.profCancelDebt);
    if (!window.confirm('Cancelar este saldo pendente (fiado) em aberto?')) return;
    await withLoading(cancelDebtBtn, async () => {
      try {
        const res = await api(`/api/debts/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Saldo pendente cancelado.');
        if (res?.member) patchMemberInState(res.member);
        if (state.selectedProfileId) await loadMemberOpenDebts(state.selectedProfileId);
        Promise.allSettled([loadOpenDebts(), loadDashboard()]).catch(() => {});
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const chargeBtn = e.target.closest('[data-prof-pay-charge]');
  if (chargeBtn) {
    const member = state.selectedProfileMember || state.allMembers.find((m) => Number(m.id) === Number(state.selectedProfileId));
    closeProfileModal(false);
    document.querySelector('.tab[data-tab="billing"]')?.click();
    await loadTab('billing');
    if (member) {
      const fullMember = state.allMembers.find((m) => Number(m.id) === Number(member.id)) || member;
      selectBillingMember(fullMember);
    }
    return;
  }
  const btn = e.target.closest('[data-prof-pay-debt]');
  if (!btn) return;
  const id = Number(btn.dataset.profPayDebt);
  const debt = (state.selectedProfileDebts || []).find((d) => d.id === id);
  if (!debt) return;
  document.getElementById('debtPayId').value = String(debt.id);
  document.getElementById('debtPayAmount').value = (Number(debt.remaining_cents) / 100).toFixed(2);
  document.getElementById('debtPayAmount').max = (Number(debt.remaining_cents) / 100).toFixed(2);
  document.getElementById('debtPayNotes').value = '';
  document.getElementById('debtPayInfo').textContent = `${state.selectedProfileName || 'Aluno'} · Saldo em aberto: ${fmtMoney(debt.remaining_cents)}`;
  document.getElementById('debtPayModal')?.showModal();
});

document.getElementById('btnQuickAddTemplate')?.addEventListener('click', async () => {
  const templateKey = document.getElementById('profQuickTemplateSelect')?.value;
  if (!templateKey) return showToast('Escolha um modelo predefinido na lista.', true);
  try { await loadExerciseCatalog(); } catch (err) { showToast(err.message, true); return; }
  const template = getWorkoutTemplate(templateKey);
  if (!template) return showToast('Modelo de treino não encontrado.', true);
  document.getElementById('wkEditId').value = '';
  document.getElementById('workoutForm').reset();
  document.getElementById('wkTemplateSelect').value = templateKey;
  document.getElementById('wkTitle').value = template.title;
  document.getElementById('wkGoal').value = template.goal || '';
  document.getElementById('wkNotes').value = template.notes || '';
  const container = document.getElementById('wkExercisesRows');
  container.replaceChildren();
  template.exercises.forEach((exercise) => addWorkoutExerciseRow(exercise, container));
  const form = document.getElementById('workoutForm');
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

