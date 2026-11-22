(() => {
  const state = {
    data: null,
    selectedStudent: null,
    memberWorkouts: [],
    activeTab: 'students',
    videoExerciseKey: null,
  };

  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden', 'toast-error');
    if (isError) el.classList.add('toast-error');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 3600);
  }

  async function api(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof ArrayBuffer) && !ArrayBuffer.isView(opts.body) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { credentials: 'include', ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erro (${res.status})`);
    return data;
  }

  async function withBusyButton(btn, fn, busyLabel = 'Salvando...') {
    if (!btn || btn.disabled) return;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('oxigenio_prof_theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#07080b' : '#f5f5f7');
  }
  const savedTheme = localStorage.getItem('oxigenio_prof_theme') || localStorage.getItem('oxigenio_student_theme') || 'light';
  applyTheme(savedTheme);
  document.getElementById('btnProfTheme')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.togglePassword);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Ocultar' : 'Mostrar';
    });
  });

  function switchTab(tab) {
    state.activeTab = tab;
    const panels = {
      students: 'profTabStudents',
      templates: 'profTabTemplates',
      exercises: 'profTabExercises',
      classes: 'profTabClasses',
      profile: 'profTabProfile',
    };
    Object.entries(panels).forEach(([key, id]) => {
      document.getElementById(id)?.classList.toggle('hidden', key !== tab);
    });
    if (tab !== 'students') {
      document.getElementById('profStudentDetail')?.classList.add('hidden');
    } else if (state.selectedStudent) {
      document.getElementById('profTabStudents')?.classList.add('hidden');
      document.getElementById('profStudentDetail')?.classList.remove('hidden');
    }
    document.querySelectorAll('[data-prof-tab]').forEach((btn) => {
      const isCurrent = btn.dataset.profTab === tab;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });
  }

  document.querySelectorAll('[data-prof-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.profTab === 'students' && state.activeTab === 'students') {
        state.selectedStudent = null;
      }
      switchTab(btn.dataset.profTab);
    });
  });

  function statusLabel(status) {
    const map = { active: 'Ativo', expired: 'Vencido', pending: 'Pendente', blocked: 'Bloqueado' };
    return map[status] || status || '—';
  }

  function renderStats() {
    const st = state.data?.stats || {};
    document.getElementById('profStatsRow').innerHTML = `
      <div class="student-stat-card">
        <span class="student-stat-label">Alunos Ativos</span>
        <strong>${Number(st.activeStudents || 0)}</strong>
        <small class="muted">de ${Number(st.totalStudents || 0)} alunos</small>
      </div>
      <div class="student-stat-card">
        <span class="student-stat-label">Modelos de Treino</span>
        <strong>${Number(st.templatesCount || 0)}</strong>
        <small class="muted">Prontos para aplicar</small>
      </div>
      <div class="student-stat-card">
        <span class="student-stat-label">Exercícios</span>
        <strong>${Number(st.catalogCount || 0)}</strong>
        <small class="muted">${Number(st.videosCount || 0)} com vídeo</small>
      </div>
    `;
  }

  function renderStudents() {
    const query = String(document.getElementById('profStudentSearch')?.value || '').trim().toLowerCase();
    const list = (state.data?.students || []).filter((s) => {
      if (!query) return true;
      return `${s.name || ''} ${s.phone || ''} ${s.plan_name || ''}`.toLowerCase().includes(query);
    });
    const el = document.getElementById('profStudentsList');
    el.innerHTML = list.length
      ? list
          .map(
            (s) => `
          <div class="prof-card">
            <div class="prof-card-head">
              <strong>${esc(s.name)}</strong>
              <span class="badge ${s.status === 'active' ? 'badge-ok' : 'badge-warn'}">${esc(statusLabel(s.status))}</span>
            </div>
            <div class="prof-card-meta">${esc(s.plan_name || 'Sem plano')} · ${Number(s.active_workouts_count || 0)} ficha(s) ativa(s)</div>
            <button type="button" class="btn btn-primary btn-sm" data-open-student="${s.id}">Gerenciar treinos e avaliação</button>
          </div>`,
          )
          .join('')
      : '<p class="muted">Nenhum aluno encontrado.</p>';
  }

  function buildExerciseRowHtml(row = {}) {
    const catalog = state.data?.exerciseCatalog || [];
    const options = catalog
      .map((ex) => `<option value="${esc(ex.key)}" ${ex.key === row.exercise_key ? 'selected' : ''}>${esc(ex.name)} (${esc(ex.muscle_group || 'Geral')})</option>`)
      .join('');
    return `
      <div class="prof-ex-row">
        <select data-ex-key required><option value="">Escolha o exercício...</option>${options}</select>
        <input type="number" data-ex-sets min="1" max="20" value="${Number(row.sets || 3)}" placeholder="Séries" title="Séries" />
        <input type="text" data-ex-reps value="${esc(row.reps || '10-12')}" placeholder="Reps" title="Repetições" />
        <input type="number" data-ex-rest min="0" max="600" value="${Number(row.rest_seconds ?? row.rest_sec ?? 60)}" placeholder="Desc(s)" title="Descanso em segundos" />
        <input type="text" data-ex-notes value="${esc(row.notes || '')}" placeholder="Obs. (opcional)" />
        <button type="button" class="btn btn-danger btn-sm" data-remove-ex-row aria-label="Remover exercício">✕</button>
      </div>`;
  }

  function collectExerciseRows(containerId) {
    const catalog = state.data?.exerciseCatalog || [];
    return [...document.querySelectorAll(`#${containerId} .prof-ex-row`)]
      .map((row) => {
        const key = row.querySelector('[data-ex-key]')?.value || '';
        const cat = catalog.find((c) => c.key === key);
        const rest = Number(row.querySelector('[data-ex-rest]')?.value ?? 60);
        return {
          exercise_key: key,
          exercise_name: cat?.name || key,
          muscle_group: cat?.muscle_group || 'Geral',
          sets: Number(row.querySelector('[data-ex-sets]')?.value || 3),
          reps: row.querySelector('[data-ex-reps]')?.value?.trim() || '10-12',
          rest_seconds: rest,
          rest_sec: rest,
          notes: row.querySelector('[data-ex-notes]')?.value?.trim() || null,
        };
      })
      .filter((r) => r.exercise_key);
  }

  async function openStudentDetail(memberId) {
    const student = (state.data?.students || []).find((s) => Number(s.id) === Number(memberId));
    if (!student) return;
    state.selectedStudent = student;
    document.getElementById('profTabStudents').classList.add('hidden');
    document.getElementById('profStudentDetail').classList.remove('hidden');
    document.getElementById('profDetailName').textContent = student.name;
    document.getElementById('profDetailMeta').textContent = `${student.plan_name || 'Sem plano'} · ${statusLabel(student.status)}${student.phone ? ` · ${student.phone}` : ''}`;
    document.getElementById('profWorkoutForm').classList.add('hidden');

    const tplSelect = document.getElementById('pwTemplateSelect');
    tplSelect.innerHTML = `<option value="">Montar do zero...</option>${(state.data?.workoutTemplates || [])
      .map((t) => `<option value="${t.id}">${esc(t.title)}${t.goal ? ` (${esc(t.goal)})` : ''}</option>`)
      .join('')}`;

    await Promise.all([loadMemberWorkouts(student.id), loadMemberAssessments(student.id)]);
  }

  async function loadMemberWorkouts(memberId) {
    const workouts = await api(`/api/professor/members/${memberId}/workouts`);
    state.memberWorkouts = workouts;
    const container = document.getElementById('profMemberWorkouts');
    container.innerHTML = workouts.length
      ? workouts
          .map(
            (w) => `
          <div class="prof-subcard">
            <div class="prof-card-head">
              <div>
                <strong>${esc(w.title)}</strong>
                ${w.goal ? `<div class="prof-card-meta">${esc(w.goal)}</div>` : ''}
              </div>
              <div class="inline-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-edit-workout="${w.id}">Editar</button>
                <button type="button" class="btn btn-danger btn-sm" data-delete-workout="${w.id}">Excluir</button>
              </div>
            </div>
            <ul class="simple-list" style="margin-top:8px;">
              ${(w.exercises || [])
                .map((ex) => `<li><strong>${esc(ex.exercise_name || ex.exercise_key)}</strong> — ${Number(ex.sets || 3)}x ${esc(ex.reps || '10-12')}${ex.rest_sec ? ` (${ex.rest_sec}s)` : ''}</li>`)
                .join('') || '<li class="muted">Sem exercícios</li>'}
            </ul>
          </div>`,
          )
          .join('')
      : '<p class="muted">Este aluno ainda não possui fichas de treino.</p>';
  }

  async function loadMemberAssessments(memberId) {
    const rows = await api(`/api/professor/members/${memberId}/assessments`);
    document.getElementById('profAssessmentsList').innerHTML = rows.length
      ? rows
          .map(
            (a) => `<li><strong>${esc((a.assessed_at || '').slice(0, 10))}</strong> · ${a.weight_kg ? `${a.weight_kg} kg` : '—'}${a.height_cm ? ` · ${a.height_cm} cm` : ''}${a.body_fat_pct ? ` · ${a.body_fat_pct}% GC` : ''}${a.notes ? ` <span class="muted">(${esc(a.notes)})</span>` : ''}</li>`,
          )
          .join('')
      : '<li class="muted">Nenhuma avaliação física registrada.</li>';
  }

  function openWorkoutForm(workout = null) {
    const form = document.getElementById('profWorkoutForm');
    form.classList.remove('hidden');
    document.getElementById('profWorkoutFormTitle').textContent = workout ? `Editar: ${workout.title}` : 'Montar Novo Treino';
    document.getElementById('pwId').value = workout ? String(workout.id) : '';
    document.getElementById('pwTemplateSelect').value = '';
    document.getElementById('pwTitle').value = workout?.title || '';
    document.getElementById('pwGoal').value = workout?.goal || '';
    document.getElementById('pwNotes').value = workout?.notes || '';
    const rows = workout?.exercises?.length ? workout.exercises : [{}];
    document.getElementById('pwExercisesList').innerHTML = rows.map(buildExerciseRowHtml).join('');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderTemplates() {
    const list = state.data?.workoutTemplates || [];
    document.getElementById('profTemplatesList').innerHTML = list.length
      ? list
          .map(
            (t) => `
          <div class="prof-card">
            <div class="prof-card-head">
              <strong>${esc(t.title)}</strong>
              <div class="inline-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-edit-tpl="${t.id}">Editar</button>
                <button type="button" class="btn btn-danger btn-sm" data-delete-tpl="${t.id}">Excluir</button>
              </div>
            </div>
            <div class="prof-card-meta">${esc(t.goal || 'Sem objetivo')} · ${(t.exercises || []).length} exercício(s)</div>
          </div>`,
          )
          .join('')
      : '<p class="muted">Nenhum modelo de treino cadastrado ainda.</p>';
  }

  function renderExercises() {
    const query = String(document.getElementById('profExSearch')?.value || '').trim().toLowerCase();
    const onlyNoVideo = Boolean(document.getElementById('profExOnlyNoVideo')?.checked);
    const list = (state.data?.exerciseCatalog || []).filter((ex) => {
      if (onlyNoVideo && ex.has_video) return false;
      if (query && !`${ex.name || ''} ${ex.muscle_group || ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
    document.getElementById('profExercisesGrid').innerHTML = list.length
      ? list
          .map(
            (ex) => `
          <div class="prof-card">
            <div class="prof-card-head">
              <div>
                <strong>${esc(ex.name)}</strong>
                <div class="prof-card-meta">${esc(ex.muscle_group || 'Geral')}</div>
              </div>
              <span class="badge ${ex.has_video ? 'badge-ok' : 'badge-warn'}">${ex.has_video ? 'Com vídeo' : 'Sem vídeo'}</span>
            </div>
            <div class="inline-actions">
              <button type="button" class="btn btn-primary btn-sm" data-ex-video="${esc(ex.key)}">${ex.has_video ? 'Ver / Regravar vídeo' : 'Gravar vídeo'}</button>
              <button type="button" class="btn btn-secondary btn-sm" data-edit-ex="${esc(ex.key)}">Editar</button>
            </div>
          </div>`,
          )
          .join('')
      : '<p class="muted">Nenhum exercício encontrado.</p>';
  }

  function renderClasses() {
    const classes = state.data?.classes || [];
    document.getElementById('profClassesGrid').innerHTML = classes.length
      ? classes
          .map(
            (c) => `
          <div class="prof-card">
            <div class="prof-card-head">
              <strong>${esc(c.name)}</strong>
              <span class="badge badge-neutral">${Number(c.enrolled_count || 0)}/${Number(c.capacity || 0)}</span>
            </div>
            <div class="prof-card-meta">${esc(c.modality_name || 'Geral')} · ${esc(c.schedule)}</div>
            <button type="button" class="btn btn-secondary btn-sm" data-prof-class="${c.id}">Ver alunos da turma</button>
          </div>`,
          )
          .join('')
      : '<p class="muted">Nenhuma turma cadastrada.</p>';
  }

  function openVideoPanel(key) {
    const ex = (state.data?.exerciseCatalog || []).find((e) => e.key === key);
    if (!ex) return;
    state.videoExerciseKey = key;
    const panel = document.getElementById('profVideoPanel');
    const player = document.getElementById('profVideoPlayer');
    const status = document.getElementById('profVideoStatus');
    const delBtn = document.getElementById('btnProfDeleteVideo');
    document.getElementById('profVideoExName').textContent = `${ex.name} (${ex.muscle_group || 'Geral'})`;
    if (ex.has_video) {
      player.src = `/api/exercise-catalog/${encodeURIComponent(key)}/video?t=${Date.now()}`;
      player.classList.remove('hidden');
      delBtn.classList.remove('hidden');
      status.textContent = 'Vídeo cadastrado. Você pode gravar outro para substituir.';
    } else {
      player.removeAttribute('src');
      player.classList.add('hidden');
      delBtn.classList.add('hidden');
      status.textContent = 'Nenhum vídeo cadastrado ainda. Toque abaixo para gravar com a câmera.';
    }
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadDashboard() {
    const data = await api('/api/professor/dashboard');
    state.data = data;
    document.getElementById('profLoginView').classList.add('hidden');
    document.getElementById('profPortalView').classList.remove('hidden');
    const profName = data.professor?.name || 'Professor';
    document.getElementById('profHeaderName').textContent = profName;
    const initialsEl = document.getElementById('profHeaderInitials');
    if (initialsEl) {
      initialsEl.textContent = profName.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || 'P';
    }
    document.getElementById('profGymHeader').textContent = data.gymName || 'Academia Oxigênio';
    document.getElementById('profProfileMeta').textContent = `${data.professor?.name || ''} · ${data.professor?.phone || data.professor?.email || ''}`;
    document.getElementById('profCurrentPassWrap').classList.toggle('hidden', !data.professor?.has_portal_password);
    renderStats();
    renderStudents();
    renderTemplates();
    renderExercises();
    renderClasses();
  }

  async function init() {
    try {
      const st = await api('/api/professor/auth/status');
      if (st.gymName) document.getElementById('profLoginGymName').textContent = st.gymName;
      if (st.authenticated) {
        await loadDashboard();
        switchTab('students');
      }
    } catch {}
  }

  document.getElementById('profLoginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        await api('/api/professor/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            identifier: document.getElementById('profLoginIdentifier').value.trim(),
            secret: document.getElementById('profLoginSecret').value.trim(),
          }),
        });
        await loadDashboard();
        switchTab('students');
      } catch (err) {
        showToast(err.message, true);
      }
    }, 'Entrando...');
  });

  document.getElementById('btnProfLogout')?.addEventListener('click', async () => {
    await api('/api/professor/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  });

  document.getElementById('profStudentSearch')?.addEventListener('input', renderStudents);
  document.getElementById('profStudentsList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-student]');
    if (btn) openStudentDetail(Number(btn.dataset.openStudent));
  });
  document.getElementById('btnProfBackStudents')?.addEventListener('click', () => {
    state.selectedStudent = null;
    document.getElementById('profStudentDetail').classList.add('hidden');
    document.getElementById('profTabStudents').classList.remove('hidden');
  });

  document.getElementById('btnProfNewWorkout')?.addEventListener('click', () => openWorkoutForm(null));
  document.getElementById('btnProfCancelWorkout')?.addEventListener('click', () => document.getElementById('profWorkoutForm').classList.add('hidden'));
  document.getElementById('btnProfAddExRow')?.addEventListener('click', () => {
    document.getElementById('pwExercisesList').insertAdjacentHTML('beforeend', buildExerciseRowHtml({}));
  });
  document.getElementById('pwTemplateSelect')?.addEventListener('change', (e) => {
    const tpl = (state.data?.workoutTemplates || []).find((t) => String(t.id) === e.target.value);
    if (!tpl) return;
    document.getElementById('pwTitle').value = tpl.title || '';
    document.getElementById('pwGoal').value = tpl.goal || '';
    document.getElementById('pwNotes').value = tpl.notes || '';
    const rows = tpl.exercises?.length ? tpl.exercises : [{}];
    document.getElementById('pwExercisesList').innerHTML = rows.map(buildExerciseRowHtml).join('');
  });

  document.addEventListener('click', (e) => {
    const rem = e.target.closest('[data-remove-ex-row]');
    if (rem) rem.closest('.prof-ex-row')?.remove();
  });

  document.getElementById('profMemberWorkouts')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-workout]');
    if (editBtn) {
      const w = state.memberWorkouts.find((x) => Number(x.id) === Number(editBtn.dataset.editWorkout));
      if (w) openWorkoutForm(w);
      return;
    }
    const delBtn = e.target.closest('[data-delete-workout]');
    if (delBtn && confirm('Excluir esta ficha de treino?')) {
      try {
        await api(`/api/professor/workouts/${Number(delBtn.dataset.deleteWorkout)}`, { method: 'DELETE' });
        showToast('Ficha excluída.');
        await Promise.all([loadMemberWorkouts(state.selectedStudent.id), loadDashboard()]);
      } catch (err) {
        showToast(err.message, true);
      }
    }
  });

  document.getElementById('profWorkoutForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedStudent) return;
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        const id = document.getElementById('pwId').value.trim();
        const payload = {
          title: document.getElementById('pwTitle').value.trim(),
          goal: document.getElementById('pwGoal').value.trim() || null,
          notes: document.getElementById('pwNotes').value.trim() || null,
          exercises: collectExerciseRows('pwExercisesList'),
        };
        if (id) {
          await api(`/api/professor/workouts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          showToast('Treino atualizado!');
        } else {
          await api(`/api/professor/members/${state.selectedStudent.id}/workouts`, { method: 'POST', body: JSON.stringify(payload) });
          showToast('Treino salvo para o aluno!');
        }
        document.getElementById('profWorkoutForm').classList.add('hidden');
        await Promise.all([loadMemberWorkouts(state.selectedStudent.id), loadDashboard()]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  document.getElementById('profAssessmentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedStudent) return;
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        await api(`/api/professor/members/${state.selectedStudent.id}/assessments`, {
          method: 'POST',
          body: JSON.stringify({
            weight_kg: document.getElementById('paWeight').value || null,
            height_cm: document.getElementById('paHeight').value || null,
            body_fat_pct: document.getElementById('paBodyFat').value || null,
            notes: document.getElementById('paNotes').value.trim() || null,
          }),
        });
        e.target.reset();
        showToast('Avaliação registrada!');
        await loadMemberAssessments(state.selectedStudent.id);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  // Modelos
  function openTemplateForm(tpl = null) {
    const form = document.getElementById('profTemplateForm');
    form.classList.remove('hidden');
    document.getElementById('profTplFormTitle').textContent = tpl ? `Editar Modelo: ${tpl.title}` : 'Novo Modelo';
    document.getElementById('ptId').value = tpl ? String(tpl.id) : '';
    document.getElementById('ptTitle').value = tpl?.title || '';
    document.getElementById('ptGoal').value = tpl?.goal || '';
    document.getElementById('ptNotes').value = tpl?.notes || '';
    const rows = tpl?.exercises?.length ? tpl.exercises : [{}];
    document.getElementById('ptExercisesList').innerHTML = rows.map(buildExerciseRowHtml).join('');
  }

  document.getElementById('btnProfNewTemplate')?.addEventListener('click', () => openTemplateForm(null));
  document.getElementById('btnProfCancelTpl')?.addEventListener('click', () => document.getElementById('profTemplateForm').classList.add('hidden'));
  document.getElementById('btnProfAddTplEx')?.addEventListener('click', () => {
    document.getElementById('ptExercisesList').insertAdjacentHTML('beforeend', buildExerciseRowHtml({}));
  });
  document.getElementById('profTemplatesList')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-tpl]');
    if (editBtn) {
      const tpl = (state.data?.workoutTemplates || []).find((t) => Number(t.id) === Number(editBtn.dataset.editTpl));
      if (tpl) openTemplateForm(tpl);
      return;
    }
    const delBtn = e.target.closest('[data-delete-tpl]');
    if (delBtn && confirm('Excluir este modelo de treino?')) {
      try {
        await api(`/api/professor/workout-templates/${Number(delBtn.dataset.deleteTpl)}`, { method: 'DELETE' });
        showToast('Modelo excluído.');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    }
  });
  document.getElementById('profTemplateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        const id = document.getElementById('ptId').value.trim();
        const payload = {
          title: document.getElementById('ptTitle').value.trim(),
          goal: document.getElementById('ptGoal').value.trim() || null,
          notes: document.getElementById('ptNotes').value.trim() || null,
          exercises: collectExerciseRows('ptExercisesList'),
        };
        if (id) {
          await api(`/api/professor/workout-templates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
          showToast('Modelo atualizado!');
        } else {
          await api('/api/professor/workout-templates', { method: 'POST', body: JSON.stringify(payload) });
          showToast('Modelo criado!');
        }
        document.getElementById('profTemplateForm').classList.add('hidden');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  // Exercícios & Vídeos
  document.getElementById('profExSearch')?.addEventListener('input', renderExercises);
  document.getElementById('profExOnlyNoVideo')?.addEventListener('change', renderExercises);
  document.getElementById('btnProfNewExercise')?.addEventListener('click', () => {
    document.getElementById('profExerciseForm').classList.remove('hidden');
    document.getElementById('profExFormTitle').textContent = 'Novo Exercício';
    document.getElementById('peKey').value = '';
    document.getElementById('peName').value = '';
    document.getElementById('peMuscle').value = '';
    document.getElementById('peUsesEq').checked = true;
    document.getElementById('peEquipment').value = '';
    document.getElementById('peEqWrap').classList.remove('hidden');
    document.getElementById('peTips').value = '';
  });
  document.getElementById('peUsesEq')?.addEventListener('change', (e) => {
    document.getElementById('peEqWrap')?.classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('btnProfCancelEx')?.addEventListener('click', () => document.getElementById('profExerciseForm').classList.add('hidden'));
  document.getElementById('profExerciseForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        const key = document.getElementById('peKey').value.trim();
        const usesEq = Boolean(document.getElementById('peUsesEq')?.checked);
        const payload = {
          name: document.getElementById('peName').value.trim(),
          muscle_group: document.getElementById('peMuscle').value.trim(),
          uses_equipment: usesEq,
          equipment: usesEq ? document.getElementById('peEquipment').value.trim() : 'Peso corporal',
          tips: document.getElementById('peTips').value.trim() || null,
        };
        if (key) {
          await api(`/api/professor/exercise-catalog/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(payload) });
          showToast('Exercício atualizado!');
        } else {
          await api('/api/professor/exercise-catalog', { method: 'POST', body: JSON.stringify(payload) });
          showToast('Exercício adicionado ao catálogo!');
        }
        document.getElementById('profExerciseForm').classList.add('hidden');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  document.getElementById('profExercisesGrid')?.addEventListener('click', (e) => {
    const vidBtn = e.target.closest('[data-ex-video]');
    if (vidBtn) {
      openVideoPanel(vidBtn.dataset.exVideo);
      return;
    }
    const editBtn = e.target.closest('[data-edit-ex]');
    if (editBtn) {
      const ex = (state.data?.exerciseCatalog || []).find((x) => x.key === editBtn.dataset.editEx);
      if (!ex) return;
      document.getElementById('profExerciseForm').classList.remove('hidden');
      document.getElementById('profExFormTitle').textContent = `Editar: ${ex.name}`;
      document.getElementById('peKey').value = ex.key;
      document.getElementById('peName').value = ex.name || '';
      document.getElementById('peMuscle').value = ex.muscle_group || '';
      const usesEq = Number(ex.uses_equipment ?? 1) === 1;
      document.getElementById('peUsesEq').checked = usesEq;
      document.getElementById('peEquipment').value = ex.equipment || '';
      document.getElementById('peEqWrap').classList.toggle('hidden', !usesEq);
      document.getElementById('peTips').value = ex.tips || '';
    }
  });

  document.getElementById('btnProfCloseVideo')?.addEventListener('click', () => {
    document.getElementById('profVideoPanel').classList.add('hidden');
    document.getElementById('profVideoPlayer').pause();
  });
  document.getElementById('btnProfRecordVideo')?.addEventListener('click', () => {
    document.getElementById('profVideoFileInput').click();
  });
  document.getElementById('profVideoFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !state.videoExerciseKey) return;
    if (file.size > 30 * 1024 * 1024) {
      showToast('O vídeo deve ter no máximo 30 MB.', true);
      e.target.value = '';
      return;
    }
    const status = document.getElementById('profVideoStatus');
    status.textContent = 'Enviando vídeo...';
    try {
      const buf = await file.arrayBuffer();
      await api(`/api/professor/exercise-catalog/${encodeURIComponent(state.videoExerciseKey)}/video`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      showToast('Vídeo salvo com sucesso!');
      await loadDashboard();
      openVideoPanel(state.videoExerciseKey);
    } catch (err) {
      status.textContent = err.message;
      showToast(err.message, true);
    } finally {
      e.target.value = '';
    }
  });
  document.getElementById('btnProfDeleteVideo')?.addEventListener('click', async () => {
    if (!state.videoExerciseKey || !confirm('Remover o vídeo deste exercício?')) return;
    try {
      await api(`/api/professor/exercise-catalog/${encodeURIComponent(state.videoExerciseKey)}/video`, { method: 'DELETE' });
      showToast('Vídeo removido.');
      await loadDashboard();
      openVideoPanel(state.videoExerciseKey);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Turmas
  document.getElementById('profClassesGrid')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-prof-class]');
    if (!btn) return;
    try {
      const data = await api(`/api/professor/classes/${Number(btn.dataset.profClass)}/members`);
      document.getElementById('profClassRosterTitle').textContent = `${data.class.name} (${data.class.schedule})`;
      document.getElementById('profClassRosterList').innerHTML = (data.members || []).length
        ? data.members.map((m) => `<li><strong>${esc(m.name)}</strong> · ${esc(statusLabel(m.status))}${m.phone ? ` · ${esc(m.phone)}` : ''}</li>`).join('')
        : '<li class="muted">Nenhum aluno matriculado nesta turma.</li>';
      document.getElementById('profClassRosterBox').classList.remove('hidden');
      document.getElementById('profClassRosterBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showToast(err.message, true);
    }
  });
  document.getElementById('btnProfCloseRoster')?.addEventListener('click', () => {
    document.getElementById('profClassRosterBox').classList.add('hidden');
  });

  // Senha pessoal
  document.getElementById('profPasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    await withBusyButton(btn, async () => {
      try {
        await api('/api/professor/me/password', {
          method: 'PUT',
          body: JSON.stringify({
            current_password: document.getElementById('profCurrentPass').value,
            new_password: document.getElementById('profNewPass').value,
          }),
        });
        e.target.reset();
        showToast('Senha atualizada!');
        await loadDashboard();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  init();
})();
