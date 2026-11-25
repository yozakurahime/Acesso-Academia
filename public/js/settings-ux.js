// --- Multi-leitor, RBAC, Auditoria & Backup ---
document.getElementById('btnSyncAllReaders')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/devices/readers/sync-all', { method: 'POST' });
      if (res.queuedForEdge) {
        showToast('Sincronização enviada para o agente local (Edge)! Os avisos antigos foram limpos.');
        await loadMembers().catch(() => {});
      } else {
        showToast(`Sincronização concluída: ${res.totalSynced ?? 0} face(s), ${res.totalErrors ?? 0} erro(s).`, (res.totalErrors ?? 0) > 0);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadRbacUsers() {
  const body = document.getElementById('rbacUsersBody');
  if (!body) return;
  const users = await api('/api/auth/users');
  body.innerHTML = users.length
    ? users.map((u) => `<tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.role)}</td>
        <td><span class="badge ${u.active ? 'badge-active' : 'badge-blocked'}">${u.active ? 'Ativo' : 'Inativo'}</span></td>
        <td class="inline-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-toggle-rbac-user="${u.id}" data-next-active="${u.active ? 0 : 1}">${u.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-del-rbac-user="${u.id}">Excluir</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-cell">Nenhum usuário RBAC cadastrado.</td></tr>';
}

document.getElementById('rbacUserForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('rbacUsername').value.trim(),
          password: document.getElementById('rbacPassword').value,
          role: document.getElementById('rbacRole').value,
        }),
      });
      e.target.reset();
      showToast('Usuário criado.');
      await loadRbacUsers();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('rbacUsersBody')?.addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('[data-toggle-rbac-user]');
  if (toggleBtn) {
    await withLoading(toggleBtn, async () => {
      try {
        await api(`/api/auth/users/${toggleBtn.dataset.toggleRbacUser}`, {
          method: 'PUT',
          body: JSON.stringify({ active: Number(toggleBtn.dataset.nextActive) }),
        });
        showToast('Usuário atualizado.');
        await loadRbacUsers();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const delBtn = e.target.closest('[data-del-rbac-user]');
  if (delBtn && window.confirm('Excluir este usuário?')) {
    await withLoading(delBtn, async () => {
      try {
        await api(`/api/auth/users/${delBtn.dataset.delRbacUser}`, { method: 'DELETE' });
        showToast('Usuário excluído.');
        await loadRbacUsers();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

async function loadAuditLogs() {
  const body = document.getElementById('auditLogsBody');
  if (!body) return;
  const rows = await api('/api/audit-logs?limit=50');
  body.innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${escapeHtml(fmtDateTime(r.created_at))}</td>
        <td>${escapeHtml(r.actor_user || 'sistema')}</td>
        <td>${escapeHtml(r.action)}</td>
        <td>${escapeHtml([r.entity, r.entity_id].filter(Boolean).join(' #') || '—')}</td>
        <td>${escapeHtml(r.details || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-cell">Nenhum registro de auditoria.</td></tr>';
}

document.getElementById('btnRefreshAudit')?.addEventListener('click', (e) => {
  withLoading(e.currentTarget, () => loadAuditLogs().catch((err) => showToast(err.message, true)));
});

async function loadBackups() {
  const list = document.getElementById('backupsList');
  if (!list) return;
  const files = await api('/api/backups');
  list.innerHTML = files.length
    ? files.map((f) => {
        const name = typeof f === 'string' ? f : f.filename;
        const sizeKb = typeof f === 'object' && f.size ? ` (${Math.round(f.size / 1024)} KB)` : '';
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span>${escapeHtml(name)}${escapeHtml(sizeKb)}</span>
          <a class="btn btn-secondary btn-sm" href="/api/backups/${encodeURIComponent(name)}" download>Baixar</a>
        </li>`;
      }).join('')
    : '<li class="muted">Nenhum backup disponível.</li>';
}

document.getElementById('btnCreateBackup')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/backups', { method: 'POST' });
      const driveNote = res.gdrive?.ok
        ? ' e enviado ao Google Drive!'
        : (res.gdrive?.error ? ` (aviso Drive: ${res.gdrive.error})` : '');
      showToast(`Backup gerado: ${res.filename || 'OK'}${driveNote}`, Boolean(res.gdrive?.error));
      await Promise.all([loadBackups(), loadSettings()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function toggleGdriveModeFields() {
  const mode = document.getElementById('gdriveMode')?.value || 'api';
  const isLocal = mode === 'local';
  document.getElementById('gdriveLocalDirWrap')?.classList.toggle('hidden', !isLocal);
  document.getElementById('gdriveApiFields')?.classList.toggle('hidden', isLocal);
  document.getElementById('btnGdriveConnect')?.classList.toggle('hidden', isLocal);
}

document.getElementById('gdriveMode')?.addEventListener('change', toggleGdriveModeFields);

async function saveGdriveSettingsFromForm() {
  const payload = {
    backup_gdrive_enabled: document.getElementById('gdriveEnabled')?.checked ? 'true' : 'false',
    backup_gdrive_mode: document.getElementById('gdriveMode')?.value || 'api',
    backup_gdrive_local_dir: document.getElementById('gdriveLocalDir')?.value.trim() || '',
    backup_gdrive_folder_id: document.getElementById('gdriveFolderId')?.value.trim() || '',
    backup_gdrive_client_id: document.getElementById('gdriveClientId')?.value.trim() || '',
  };
  const secret = document.getElementById('gdriveClientSecret')?.value.trim();
  if (secret) payload.backup_gdrive_client_secret = secret;
  const refresh = document.getElementById('gdriveRefreshToken')?.value.trim();
  if (refresh) payload.backup_gdrive_refresh_token = refresh;
  const sa = document.getElementById('gdriveServiceAccount')?.value.trim();
  if (sa) payload.backup_gdrive_service_account_json = sa;
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
}

document.getElementById('gdriveBackupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      showToast('Configuração do Google Drive salva.');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnGdriveConnect')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      const { url } = await api('/api/backups/gdrive/auth-url');
      window.location.href = url;
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnGdriveSyncNow')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      const res = await api('/api/backups/gdrive/sync', { method: 'POST' });
      showToast(`Backup enviado para o Google Drive: ${res.gdrive?.filename || 'OK'}`);
      await Promise.all([loadBackups(), loadSettings()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});


// ===== SETTINGS WORKSPACE UX/UI =====
let activeSettingsCategory = 'general';
let lastFocusedWaTemplate = null;

let activeSettingsSubIndex = 0;

function getCategorySubCards(category) {
  return [...document.querySelectorAll(`#settingsContent .settings-card[data-settings-cat="${category}"]`)].filter(
    (card) => !card.classList.contains('hidden'),
  );
}

function renderSettingsSubNav(category, subIndex = 0) {
  const subNav = document.getElementById('settingsSubNav');
  const cards = getCategorySubCards(category);
  document.querySelectorAll('#settingsContent .settings-card').forEach((card) => {
    card.classList.remove('settings-sub-hidden');
  });
  if (!subNav || cards.length <= 1) {
    if (subNav) {
      subNav.classList.add('hidden');
      subNav.innerHTML = '';
    }
    activeSettingsSubIndex = 0;
    return;
  }
  const safeIdx = Math.max(0, Math.min(subIndex, cards.length - 1));
  activeSettingsSubIndex = safeIdx;
  subNav.classList.remove('hidden');
  subNav.innerHTML = cards
    .map((card, idx) => {
      const title = card.querySelector('h3')?.textContent?.trim() || `Seção ${idx + 1}`;
      return `<button type="button" class="settings-subnav-btn ${idx === safeIdx ? 'active' : ''}" role="tab" aria-selected="${idx === safeIdx ? 'true' : 'false'}" data-settings-sub="${idx}">${escapeHtml(title)}</button>`;
    })
    .join('');
  cards.forEach((card, idx) => {
    card.classList.toggle('settings-sub-hidden', idx !== safeIdx);
  });
}

function activateSettingsCategory(category = 'general', subIndex = 0) {
  activeSettingsCategory = category;
  const searchInput = document.getElementById('settingsSearchInput');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    document.getElementById('btnClearSettingsSearch')?.classList.add('hidden');
  }
  document.getElementById('settingsSearchEmpty')?.classList.add('hidden');

  document.querySelectorAll('#settingsNav .settings-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsCat === category);
  });
  document.querySelectorAll('#settingsContent [data-settings-cat]').forEach((el) => {
    el.classList.toggle('settings-cat-hidden', el.dataset.settingsCat !== category);
  });
  renderSettingsSubNav(category, subIndex);
  if (category === 'devices') loadOnce(loadDevices).catch(() => {});
  else if (category === 'structure') Promise.all([loadOnce(loadGymStructure), loadOnce(loadPlans)]).catch(() => {});
  else if (category === 'whatsapp') loadWhatsappStatus().catch(() => {});
  else if (category === 'system') {
    Promise.all([loadRbacUsers().catch(() => {}), loadAuditLogs().catch(() => {}), loadBackups().catch(() => {})]).catch(() => {});
  }
}

function getSettingsSearchHaystack(el) {
  if (!el.dataset.searchCache) {
    el.dataset.searchCache = `${el.dataset.settingsKeywords || ''} ${el.textContent || ''}`.toLowerCase();
  }
  return el.dataset.searchCache;
}

function filterSettingsContent(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const clearBtn = document.getElementById('btnClearSettingsSearch');
  const emptyEl = document.getElementById('settingsSearchEmpty');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query);

  if (!query) {
    activateSettingsCategory(activeSettingsCategory, activeSettingsSubIndex);
    return;
  }

  document.getElementById('settingsSubNav')?.classList.add('hidden');
  document.querySelectorAll('#settingsContent .settings-card').forEach((card) => {
    card.classList.remove('settings-sub-hidden');
  });

  document.querySelectorAll('#settingsNav .settings-nav-btn').forEach((btn) => {
    btn.classList.remove('active');
  });

  let visibleCards = 0;
  document.querySelectorAll('#settingsContent > [data-settings-cat]').forEach((block) => {
    if (block.classList.contains('hidden')) {
      block.classList.add('settings-cat-hidden');
      return;
    }
    const nestedCards = block.querySelectorAll('.settings-card');
    if (nestedCards.length > 0) {
      let anyNestedVisible = false;
      nestedCards.forEach((card) => {
        if (card.classList.contains('hidden')) {
          card.classList.add('settings-cat-hidden');
          return;
        }
        const hay = getSettingsSearchHaystack(card);
        const match = hay.includes(query);
        card.classList.toggle('settings-cat-hidden', !match);
        if (match) {
          anyNestedVisible = true;
          visibleCards += 1;
        }
      });
      block.classList.toggle('settings-cat-hidden', !anyNestedVisible);
      return;
    }

    const hay = getSettingsSearchHaystack(block);
    const match = hay.includes(query);
    block.classList.toggle('settings-cat-hidden', !match);
    if (match) visibleCards += 1;
  });

  if (emptyEl) emptyEl.classList.toggle('hidden', visibleCards > 0);
}

document.getElementById('settingsNav')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-btn[data-settings-cat]');
  if (!btn) return;
  activateSettingsCategory(btn.dataset.settingsCat, 0);
});

document.getElementById('settingsSubNav')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-subnav-btn[data-settings-sub]');
  if (!btn) return;
  const idx = Number(btn.dataset.settingsSub) || 0;
  activateSettingsCategory(activeSettingsCategory, idx);
});

let settingsSearchTimer = null;
document.getElementById('settingsSearchInput')?.addEventListener('input', (e) => {
  const val = e.target.value;
  clearTimeout(settingsSearchTimer);
  settingsSearchTimer = setTimeout(() => filterSettingsContent(val), 120);
});

document.getElementById('btnClearSettingsSearch')?.addEventListener('click', () => {
  activateSettingsCategory(activeSettingsCategory);
  document.getElementById('settingsSearchInput')?.focus();
});

['waTplPayment', 'waTplDue', 'waTplInactive'].forEach((id) => {
  document.getElementById(id)?.addEventListener('focus', (e) => {
    lastFocusedWaTemplate = e.target;
  });
});

document.querySelectorAll('.wa-placeholder-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const token = chip.dataset.placeholder || chip.textContent || '';
    const target = lastFocusedWaTemplate || document.getElementById('waTplDue');
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
    target.focus();
    const nextPos = start + token.length;
    if (typeof target.setSelectionRange === 'function') {
      target.setSelectionRange(nextPos, nextPos);
    }
  });
});

activateSettingsCategory('general');

