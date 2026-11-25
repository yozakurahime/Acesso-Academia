// ---- Atendimento / Chat WhatsApp ----
let chatItemsCache = [];
let activeChatPhone = null;
let chatPollTimer = null;

let lastNeedsHumanCount = null;

function updateChatNavBadge(data) {
  const badge = document.getElementById('chatNavBadge');
  const humanCount = Number(data?.needsHumanCount || 0);
  if (lastNeedsHumanCount !== null && humanCount > lastNeedsHumanCount) {
    showToast('Novo atendimento aguardando recepção!');
  }
  lastNeedsHumanCount = humanCount;
  if (!badge) return;
  const count = humanCount || Number(data?.unreadTotal || 0);
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

let chatFilterMode = 'all';

function formatChatDateDivider(rawDate) {
  const iso = String(rawDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  if (iso === today) return 'Hoje';
  const yesterday = new Intl.DateTimeFormat('sv-SE').format(new Date(Date.now() - 86400000));
  if (iso === yesterday) return 'Ontem';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function formatChatItemTime(rawDate) {
  const s = String(rawDate || '');
  if (s.length < 16) return '';
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  if (s.slice(0, 10) === today) return s.slice(11, 16);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

function formatWhatsappTextHtml(raw) {
  return escapeHtml(raw).replace(/\*([^\*\n]+)\*/g, '<strong>$1</strong>');
}

function renderChatList() {
  const listEl = document.getElementById('chatList');
  if (!listEl) return;
  const q = String(document.getElementById('chatSearchInput')?.value || '').trim().toLowerCase();
  const filtered = chatItemsCache.filter((c) => {
    if (chatFilterMode === 'human' && Number(c.needs_human) !== 1) return false;
    if (chatFilterMode === 'unread' && Number(c.unread_count || 0) <= 0) return false;
    if (!q) return true;
    const name = String(c.member_name || c.contact_name || '').toLowerCase();
    return name.includes(q) || String(c.phone || '').includes(q);
  });

  const renderKey = `${activeChatPhone || ''}|${chatFilterMode}|${q}|${filtered.map((c) => `${c.phone}:${c.last_message_at || ''}:${c.unread_count || 0}:${c.needs_human || 0}:${c.internal_note ? 1 : 0}:${c.opt_out || 0}`).join(';')}`;
  if (listEl.dataset.renderKey === renderKey) return;
  listEl.dataset.renderKey = renderKey;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="muted" style="padding:12px;">Nenhuma conversa encontrada.</div>';
    return;
  }

  listEl.innerHTML = filtered.map((c) => {
    const title = c.member_name || c.contact_name || c.phone;
    const initials = memberInitials(title);
    const activeClass = c.phone === activeChatPhone ? ' active' : '';
    const isHuman = Number(c.needs_human) === 1;
    const isOptOut = Number(c.opt_out) === 1;
    const humanTag = isHuman
      ? '<span class="badge badge-pending">Atendente</span>'
      : (Number(c.unread_count) > 0 ? `<span class="badge badge-active">${Number(c.unread_count)}</span>` : '');
    const optOutBadge = isOptOut ? '<span title="Disparos automáticos parados" aria-label="Disparos automáticos parados" style="font-size:11px;opacity:0.85;">🔕</span>' : '';
    const noteBadge = c.internal_note ? '<span title="Possui nota interna" aria-label="Possui nota interna" style="font-size:11px;opacity:0.75;">📝</span>' : '';
    const timeStr = formatChatItemTime(c.last_message_at);
    return `
      <button type="button" class="chat-item${activeClass}" data-chat-phone="${escapeHtml(c.phone)}">
        <div class="chat-item-avatar${isHuman ? ' is-human' : ''}">${escapeHtml(initials)}</div>
        <div class="chat-item-body">
          <div class="chat-item-top">
            <strong class="chat-item-name">${escapeHtml(title)}</strong>
            <span class="chat-item-time">${escapeHtml(timeStr)}</span>
          </div>
          <div class="chat-item-bottom">
            <div class="chat-item-preview">${escapeHtml(c.last_message || '')}</div>
            ${optOutBadge}${noteBadge}${humanTag}
          </div>
        </div>
      </button>
    `;
  }).join('');
}

async function openChat(phone) {
  if (!phone) return;
  if (!quickRepliesCache.length) {
    loadQuickReplies();
  }
  const isNewChatSelection = activeChatPhone !== phone;
  activeChatPhone = phone;
  document.getElementById('chatLayout')?.classList.add('has-active-chat');
  renderChatList();
  const data = await api(`/api/whatsapp/chats/${encodeURIComponent(phone)}/messages`);
  const chat = data.chat || { phone };
  const title = chat.member_name || chat.contact_name || chat.phone;
  const paused = Number(chat.bot_paused) === 1;
  const needsHuman = Number(chat.needs_human) === 1;
  const optOut = Number(chat.opt_out) === 1;
  const hasNote = Boolean(String(chat.internal_note || '').trim());
  const headerEl = document.getElementById('chatHeader');
  if (headerEl) {
    const toggleLabel = needsHuman ? 'Resolver e retomar bot' : (paused ? 'Retomar bot' : 'Pausar bot');
    const optOutLabel = optOut ? '🔕 Disparos parados' : 'Parar disparos';
    const optOutTitle = optOut
      ? 'Disparos automáticos bloqueados para este número (clique para reativar)'
      : 'Parar disparos automáticos (cobrança, aniversário, inatividade) para este número';
    const validLabel = chat.member_valid_until ? ` · vence ${chat.member_valid_until}` : '';
    const memberBtnHtml = chat.member_id
      ? '<button type="button" id="btnChatMemberBilling" class="btn btn-secondary btn-sm">Cobrar / Plano</button>'
      : '';
    headerEl.innerHTML = `
      <div class="chat-header-info">
        <button type="button" id="btnChatBackMobile" class="btn btn-secondary btn-sm chat-back-btn" aria-label="Voltar para a lista">←</button>
        <div class="chat-item-avatar${needsHuman ? ' is-human' : ''}">${escapeHtml(memberInitials(title))}</div>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <div class="muted" style="font-size:12px;">${escapeHtml(chat.phone)}${chat.member_status ? ` · ${escapeHtml(chat.member_status)}` : ''}${escapeHtml(validLabel)}</div>
        </div>
      </div>
      <div class="inline-actions">
        <button type="button" id="btnToggleChatNote" class="btn btn-secondary btn-sm" title="Nota interna">${hasNote ? '📝 Nota' : 'Nota'}</button>
        ${memberBtnHtml}
        <button type="button" id="btnToggleChatOptOut" class="btn ${optOut ? 'btn-danger' : 'btn-secondary'} btn-sm" title="${escapeHtml(optOutTitle)}">${optOutLabel}</button>
        <button type="button" id="btnToggleChatBot" class="btn ${needsHuman ? 'btn-primary' : 'btn-secondary'} btn-sm">${toggleLabel}</button>
      </div>
    `;
    document.getElementById('btnChatBackMobile')?.addEventListener('click', () => {
      document.getElementById('chatLayout')?.classList.remove('has-active-chat');
    });
    document.getElementById('btnToggleChatNote')?.addEventListener('click', () => {
      const noteBar = document.getElementById('chatNoteBar');
      if (!noteBar) return;
      const hiddenNow = noteBar.classList.toggle('hidden');
      if (!hiddenNow) document.getElementById('chatNoteInput')?.focus();
    });
    document.getElementById('btnChatMemberBilling')?.addEventListener('click', async () => {
      try {
        let member = (state.allMembers || []).find((m) => Number(m.id) === Number(chat.member_id));
        if (!member) {
          const prof = await api(`/api/members/${Number(chat.member_id)}/profile`);
          member = prof?.member || null;
        }
        if (!member) {
          showToast('Cadastro do aluno não encontrado.', true);
          return;
        }
        await jumpToPaymentForMember(member);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    document.getElementById('btnToggleChatOptOut')?.addEventListener('click', async () => {
      try {
        await api(`/api/whatsapp/chats/${encodeURIComponent(phone)}/opt-out`, {
          method: 'POST',
          body: JSON.stringify({ optOut: !optOut }),
        });
        showToast(optOut ? 'Disparos automáticos reativados para este número.' : 'Disparos automáticos bloqueados para este número.');
        await Promise.all([openChat(phone), loadChats({ skipActiveReload: true })]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    document.getElementById('btnToggleChatBot')?.addEventListener('click', async () => {
      try {
        await api(`/api/whatsapp/chats/${encodeURIComponent(phone)}/bot`, {
          method: 'POST',
          body: JSON.stringify({ paused: !paused }),
        });
        showToast(paused ? 'Bot retomado para este contato.' : 'Bot pausado para este contato.');
        await Promise.all([openChat(phone), loadChats({ skipActiveReload: true })]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  const handoffEl = document.getElementById('chatHandoffBanner');
  if (handoffEl) {
    if (needsHuman) {
      const summaryText = chat.handoff_summary
        ? `Motivo do transbordo: ${chat.handoff_summary}`
        : 'Este contato solicitou atendimento humano (bot pausado).';
      handoffEl.textContent = summaryText;
      handoffEl.classList.remove('hidden');
    } else {
      handoffEl.classList.add('hidden');
    }
  }

  const msgsEl = document.getElementById('chatMessages');
  if (msgsEl) {
    const msgs = data.messages || [];
    const renderKey = `${phone}:${msgs.length}:${msgs[msgs.length - 1]?.id || 0}`;
    if (msgsEl.dataset.renderKey !== renderKey) {
      const nearBottom = isNewChatSelection || (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) < 80;
      msgsEl.dataset.renderKey = renderKey;
      let lastDateKey = '';
      let prevSenderKey = '';
      msgsEl.innerHTML = msgs.map((m) => {
        const cls = m.direction === 'in' ? 'in' : 'out';
        const roleCls = m.direction === 'out' ? (m.sender_type === 'bot' ? 'bot' : 'human') : '';
        const who = m.sender_type === 'bot' ? 'Bot IA' : (m.sender_type === 'human' ? 'Atendente' : 'Cliente');
        const rawDate = String(m.created_at || '');
        const dateKey = rawDate.slice(0, 10);
        const dividerLabel = dateKey && dateKey !== lastDateKey ? formatChatDateDivider(rawDate) : '';
        if (dateKey) lastDateKey = dateKey;
        const dividerHtml = dividerLabel ? `<div class="chat-date-divider">${escapeHtml(dividerLabel)}</div>` : '';
        const senderKey = `${dateKey}:${cls}:${m.sender_type || ''}`;
        const groupedCls = !dividerLabel && prevSenderKey === senderKey ? ' chat-bubble--grouped' : '';
        prevSenderKey = senderKey;
        const time = rawDate.length >= 16 ? rawDate.slice(11, 16) : rawDate;
        let mediaHtml = '';
        if (m.media_url) {
          if (m.media_type === 'image') {
            mediaHtml = `<img src="${escapeHtml(m.media_url)}" alt="Imagem enviada" loading="lazy" width="240" height="180" style="width:auto;height:auto;max-width:240px;max-height:260px;border-radius:10px;display:block;margin-bottom:6px;cursor:pointer;" onclick="window.open(this.src,'_blank','noopener,noreferrer')" />`;
          } else if (m.media_type === 'sticker') {
            mediaHtml = `<img src="${escapeHtml(m.media_url)}" alt="Figurinha" loading="lazy" width="140" height="140" style="max-width:140px;height:auto;display:block;margin-bottom:6px;" />`;
          } else if (m.media_type === 'audio') {
            mediaHtml = `<audio controls preload="none" src="${escapeHtml(m.media_url)}" style="max-width:240px;height:36px;display:block;margin-bottom:6px;"></audio>`;
          }
        }
        const cleanText = String(m.body || '').replace(/^\[ts=\d+\]\s*/i, '');
        const bodyHtml = cleanText ? `<div>${formatWhatsappTextHtml(cleanText)}</div>` : '';
        return `${dividerHtml}
          <div class="chat-bubble ${cls} ${roleCls}${groupedCls}">
            ${mediaHtml}${bodyHtml}
            <div class="chat-bubble-meta">${escapeHtml(who)} · ${escapeHtml(time)}</div>
          </div>
        `;
      }).join('');
      if (nearBottom) {
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    }
  }

  const noteBarEl = document.getElementById('chatNoteBar');
  const noteInputEl = document.getElementById('chatNoteInput');
  if (noteBarEl && noteInputEl) {
    if (isNewChatSelection) {
      noteBarEl.classList.toggle('hidden', !hasNote);
    }
    if (document.activeElement !== noteInputEl) {
      noteInputEl.value = chat.internal_note || '';
    }
  }

  document.getElementById('chatQuickReplies')?.classList.remove('hidden');
  document.getElementById('chatReplyForm')?.classList.remove('hidden');
}

async function loadChats({ skipActiveReload = false } = {}) {
  const prevActive = activeChatPhone
    ? chatItemsCache.find((c) => c.phone === activeChatPhone)
    : null;
  const data = await api('/api/whatsapp/chats');
  chatItemsCache = data.items || [];
  updateChatNavBadge(data);
  renderChatList();
  if (!skipActiveReload && activeChatPhone) {
    const nextActive = chatItemsCache.find((c) => c.phone === activeChatPhone);
    const activeChanged = !prevActive || !nextActive
      || prevActive.last_message_at !== nextActive.last_message_at
      || Number(prevActive.unread_count || 0) !== Number(nextActive.unread_count || 0)
      || Number(prevActive.needs_human || 0) !== Number(nextActive.needs_human || 0)
      || Number(prevActive.opt_out || 0) !== Number(nextActive.opt_out || 0);
    if (activeChanged) {
      await openChat(activeChatPhone);
    }
  }
  clearTimeout(chatPollTimer);
  if (state.activeTab === 'chat' && !document.hidden) {
    chatPollTimer = setTimeout(() => {
      if (state.activeTab === 'chat' && !document.hidden) {
        loadChats().catch(() => {});
      }
    }, 8000);
  }
}

document.getElementById('btnRefreshChats')?.addEventListener('click', () => {
  loadChats().catch((err) => showToast(err.message, true));
});
let chatSearchTimer = null;
document.getElementById('chatSearchInput')?.addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(renderChatList, 150);
});
document.getElementById('chatFilterBar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.chat-filter-btn');
  if (!btn) return;
  chatFilterMode = btn.dataset.chatFilter || 'all';
  document.querySelectorAll('.chat-filter-btn').forEach((b) => {
    const active = b === btn;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-secondary', !active);
  });
  renderChatList();
});
let quickRepliesCache = [];

function renderQuickReplies() {
  const container = document.getElementById('chatQuickReplies');
  if (!container) return;
  const buttons = quickRepliesCache.map((item) => (
    `<button type="button" class="btn btn-secondary btn-sm chat-quick-btn" data-quick-text="${escapeHtml(item.text)}">${escapeHtml(item.label)}</button>`
  )).join('');
  container.innerHTML = `${buttons}<button type="button" id="btnEditQuickReplies" class="btn btn-secondary btn-sm" title="Editar respostas rápidas">Editar atalhos</button>`;
}

function renderQuickRepliesEditor() {
  const rowsEl = document.getElementById('chatQuickRepliesRows');
  if (!rowsEl) return;
  rowsEl.innerHTML = quickRepliesCache.map((item, idx) => `
    <div class="quick-reply-edit-row" data-idx="${idx}" style="display:flex;gap:6px;align-items:center;">
      <input type="text" class="qr-label-input" value="${escapeHtml(item.label)}" placeholder="Nome do botão" maxlength="40" style="width:140px;padding:4px 8px;font-size:12px;" />
      <input type="text" class="qr-text-input" value="${escapeHtml(item.text)}" placeholder="Texto da mensagem..." maxlength="600" style="flex:1;padding:4px 8px;font-size:12px;" />
      <button type="button" class="btn btn-secondary btn-sm qr-remove-btn" title="Remover">×</button>
    </div>
  `).join('');
}

async function loadQuickReplies() {
  try {
    const data = await api('/api/whatsapp/quick-replies');
    quickRepliesCache = Array.isArray(data.items) ? data.items : [];
    renderQuickReplies();
  } catch {
    // fallback silencioso
  }
}

document.getElementById('chatQuickReplies')?.addEventListener('click', (e) => {
  if (e.target.closest('#btnEditQuickReplies')) {
    const editor = document.getElementById('chatQuickRepliesEditor');
    if (editor) {
      renderQuickRepliesEditor();
      editor.classList.toggle('hidden');
    }
    return;
  }
  const btn = e.target.closest('.chat-quick-btn');
  const input = document.getElementById('chatReplyInput');
  if (!btn || !input) return;
  input.value = btn.dataset.quickText || '';
  input.focus();
});

document.getElementById('chatQuickRepliesRows')?.addEventListener('click', (e) => {
  if (!e.target.closest('.qr-remove-btn')) return;
  e.target.closest('.quick-reply-edit-row')?.remove();
});

document.getElementById('btnAddQuickReplyRow')?.addEventListener('click', () => {
  const rowsEl = document.getElementById('chatQuickRepliesRows');
  if (!rowsEl) return;
  const row = document.createElement('div');
  row.className = 'quick-reply-edit-row';
  row.style.cssText = 'display:flex;gap:6px;align-items:center;';
  row.innerHTML = `
    <input type="text" class="qr-label-input" value="" placeholder="Nome do botão" maxlength="40" style="width:140px;padding:4px 8px;font-size:12px;" />
    <input type="text" class="qr-text-input" value="" placeholder="Texto da mensagem..." maxlength="600" style="flex:1;padding:4px 8px;font-size:12px;" />
    <button type="button" class="btn btn-secondary btn-sm qr-remove-btn" title="Remover">×</button>
  `;
  rowsEl.appendChild(row);
});

document.getElementById('btnCancelQuickReplies')?.addEventListener('click', () => {
  document.getElementById('chatQuickRepliesEditor')?.classList.add('hidden');
});

document.getElementById('btnSaveQuickReplies')?.addEventListener('click', async () => {
  const rows = Array.from(document.querySelectorAll('#chatQuickRepliesRows .quick-reply-edit-row'));
  const items = rows.map((row) => ({
    label: String(row.querySelector('.qr-label-input')?.value || '').trim(),
    text: String(row.querySelector('.qr-text-input')?.value || '').trim(),
  })).filter((item) => item.label && item.text);
  try {
    const data = await api('/api/whatsapp/quick-replies', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
    quickRepliesCache = data.items || [];
    renderQuickReplies();
    document.getElementById('chatQuickRepliesEditor')?.classList.add('hidden');
    showToast('Respostas rápidas salvas.');
  } catch (err) {
    showToast(err.message, true);
  }
});
document.getElementById('btnSaveChatNote')?.addEventListener('click', async () => {
  if (!activeChatPhone) return;
  const note = String(document.getElementById('chatNoteInput')?.value || '').trim();
  try {
    await api(`/api/whatsapp/chats/${encodeURIComponent(activeChatPhone)}/note`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    showToast(note ? 'Nota interna salva.' : 'Nota interna removida.');
  } catch (err) {
    showToast(err.message, true);
  }
});
document.getElementById('chatList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chat-phone]');
  if (!btn) return;
  openChat(btn.dataset.chatPhone).catch((err) => showToast(err.message, true));
});
const chatReplyInputEl = document.getElementById('chatReplyInput');
if (chatReplyInputEl) {
  const autoResizeReply = () => {
    chatReplyInputEl.style.height = 'auto';
    chatReplyInputEl.style.height = `${Math.min(chatReplyInputEl.scrollHeight, 120)}px`;
  };
  chatReplyInputEl.addEventListener('input', autoResizeReply);
  chatReplyInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('chatReplyForm')?.requestSubmit();
    }
  });
}

document.getElementById('chatReplyForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeChatPhone) return;
  const input = document.getElementById('chatReplyInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  try {
    await api(`/api/whatsapp/chats/${encodeURIComponent(activeChatPhone)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    input.value = '';
    input.style.height = 'auto';
    await Promise.all([openChat(activeChatPhone), loadChats({ skipActiveReload: true })]);
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---- Subaba Contexto do Bot IA (WhatsApp & IA) ----
async function loadWhatsappBotContext() {
  try {
    const data = await api('/api/whatsapp/bot-context');
    const enabledEl = document.getElementById('waBotEnabled');
    const textEl = document.getElementById('waBotContextText');
    if (enabledEl) enabledEl.checked = Boolean(data.enabled);
    if (textEl) textEl.value = data.context || '';
  } catch (err) {
    showToast(err.message, true);
  }
}

document.querySelectorAll('.wa-subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.waSubtab;
    document.querySelectorAll('.wa-subtab-btn').forEach((b) => {
      const active = b.dataset.waSubtab === target;
      b.classList.toggle('btn-primary', active);
      b.classList.toggle('btn-secondary', !active);
      b.setAttribute('aria-selected', String(active));
    });
    document.getElementById('waSubtabRules')?.classList.toggle('hidden', target !== 'rules');
    document.getElementById('waSubtabContext')?.classList.toggle('hidden', target !== 'context');
    if (target === 'context') {
      loadWhatsappBotContext();
    }
  });
});

document.getElementById('waBotContextForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        whatsapp_bot_enabled: document.getElementById('waBotEnabled')?.checked ? '1' : '0',
        whatsapp_bot_context: document.getElementById('waBotContextText')?.value || '',
      }),
    });
    showToast('Contexto do Bot IA salvo com sucesso.');
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btnWaBotContextReset')?.addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ whatsapp_bot_context: '' }),
    });
    await loadWhatsappBotContext();
    showToast('Contexto restaurado para o padrão.');
  } catch (err) {
    showToast(err.message, true);
  }
});

// PWA + sincronização offline da recepção (não interfere no fluxo online nem no atualizador local)
if ('serviceWorker' in navigator && !window.oxigenioDemo) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
}

window.addEventListener('online', () => {
  updateOfflineStatusUi();
  syncOfflineQueue().catch(() => {});
});
window.addEventListener('offline', () => {
  updateOfflineStatusUi();
});
document.getElementById('offlineSyncBadge')?.addEventListener('click', () => {
  if (navigator.onLine === false) {
    showToast('Sem internet no momento. Os registros serão enviados automaticamente quando conectar.');
    return;
  }
  syncOfflineQueue().catch(() => {});
});

updateOfflineStatusUi();
if (navigator.onLine !== false && readOfflineQueue().length > 0) {
  syncOfflineQueue({ silent: true }).catch(() => {});
}
setInterval(() => {
  if (navigator.onLine !== false && readOfflineQueue().length > 0) {
    syncOfflineQueue({ silent: true }).catch(() => {});
  }
}, 15000);

