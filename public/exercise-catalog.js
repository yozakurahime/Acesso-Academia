let exerciseCatalogEntries = [];

const exerciseUi = Object.fromEntries([
  'CatalogDialog', 'CatalogList', 'CatalogCount', 'Search', 'EquipmentFilter', 'VideoFilter', 'PrevPage', 'NextPage',
  'Close', 'EditTitle', 'EditForm', 'Name', 'Muscle', 'UsesEquipment', 'EquipmentField', 'Equipment', 'Tips',
  'VideoPanel', 'Record', 'Stop', 'ChooseVideo', 'CameraFile', 'VideoFile', 'VideoPreview', 'VideoStatus', 'SaveVideo', 'RemoveVideo',
  'VideoTrimPanel', 'TrimStart', 'TrimEnd', 'TrimStartLabel', 'TrimEndLabel', 'TrimSummary', 'SetStartNow', 'SetEndNow',
  'VideoRotate', 'VideoSpeed', 'VideoFlip', 'RotateBtn', 'RotateLabel', 'FlipBtn', 'SpeedBtn', 'SpeedLabel',
  'PreviewEdit', 'ApplyEdit', 'DiscardDraft',
].map((id) => [id, document.getElementById('exercise' + id)]));

const exerciseEditor = { page: 0, current: null, pending: false, draft: null, stream: null, recorder: null, previewUrl: null, duration: 0, editedApplied: false };
const videoLimit = 30 * 1024 * 1024;
const rawMobileVideoLimit = 120 * 1024 * 1024;
const normalizeExerciseSearch = (value) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const exerciseApiPath = (key) => '/api/exercise-catalog/' + encodeURIComponent(key);

async function loadExerciseCatalog() {
  exerciseCatalogEntries = await api('/api/exercise-catalog');
  renderExerciseCatalog();
}

function renderExerciseCatalog() {
  const { CatalogList, CatalogCount, Search, EquipmentFilter, VideoFilter, PrevPage, NextPage } = exerciseUi;
  const terms = normalizeExerciseSearch(Search.value.trim()).split(/\s+/);
  const matches = exerciseCatalogEntries.filter((entry) =>
    (!EquipmentFilter.value || Number(EquipmentFilter.value) === entry.uses_equipment) &&
    (!VideoFilter.value || Number(VideoFilter.value) === entry.has_video) &&
    terms.every((term) => normalizeExerciseSearch(`${entry.name} ${entry.muscle_group} ${entry.equipment}`).includes(term)));
  const pageSize = 10;
  exerciseEditor.page = Math.min(exerciseEditor.page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const start = exerciseEditor.page * pageSize;
  CatalogCount.textContent = matches.length
    ? `${start + 1}–${Math.min(start + pageSize, matches.length)} de ${matches.length} exercícios`
    : 'Nenhum exercício encontrado.';
  PrevPage.disabled = start === 0;
  NextPage.disabled = start + pageSize >= matches.length;
  CatalogList.innerHTML = matches.slice(start, start + pageSize).map((entry) => `
    <li class="enrollment-row">
      <div><strong>${escapeHtml(entry.name)}</strong>
        <div class="muted">${escapeHtml(entry.muscle_group)} · ${escapeHtml(entry.equipment)} · ${entry.has_video ? 'Com vídeo' : 'Sem vídeo'}</div>
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-catalog-exercise="${escapeHtml(entry.key)}"
        aria-label="Editar ${escapeHtml(entry.name)}">Editar / gravar</button>
    </li>`).join('');
}

for (const field of [exerciseUi.Search, exerciseUi.EquipmentFilter, exerciseUi.VideoFilter]) {
  field.addEventListener('input', () => {
    exerciseEditor.page = 0;
    renderExerciseCatalog();
  });
}
exerciseUi.PrevPage.addEventListener('click', () => { exerciseEditor.page--; renderExerciseCatalog(); });
exerciseUi.NextPage.addEventListener('click', () => { exerciseEditor.page++; renderExerciseCatalog(); });

function showEquipmentField() {
  const required = exerciseUi.UsesEquipment.value === '1';
  exerciseUi.EquipmentField.classList.toggle('hidden', !required);
  exerciseUi.Equipment.required = required;
}

function renderVideoEditor(message) {
  const { current, draft, pending, recorder } = exerciseEditor;
  const { VideoPanel, Record, Stop, ChooseVideo, VideoPreview, VideoStatus, SaveVideo, RemoveVideo, Close, EditForm, VideoTrimPanel } = exerciseUi;
  const recording = recorder?.state === 'recording';
  VideoPanel.classList.toggle('hidden', !current);
  Record.disabled = ChooseVideo.disabled = pending || recording;
  Stop.classList.toggle('hidden', !recording);
  SaveVideo.classList.toggle('hidden', !draft);
  SaveVideo.disabled = pending || recording;
  if (VideoTrimPanel) VideoTrimPanel.classList.toggle('hidden', !draft || recording);
  RemoveVideo.classList.toggle('hidden', !current?.has_video);
  RemoveVideo.disabled = pending || recording;
  Close.disabled = pending;
  EditForm.querySelector('button').disabled = pending || recording;
  if (message !== undefined) VideoStatus.textContent = message;
  if (exerciseEditor.stream) return;

  const source = draft ? exerciseEditor.previewUrl : current?.has_video ? exerciseApiPath(current.key) + '/video' : '';
  VideoPreview.controls = Boolean(source);
  VideoPreview.classList.toggle('hidden', !source);
  if (source === (VideoPreview.getAttribute('src') || '')) return;
  if (source) VideoPreview.src = source;
  else VideoPreview.removeAttribute('src');
  VideoPreview.load();
}

function editCatalogExercise(entry = null) {
  exerciseEditor.current = entry;
  exerciseUi.EditTitle.textContent = entry ? 'Editar exercício' : 'Novo exercício';
  exerciseUi.Name.value = entry?.name || '';
  exerciseUi.Muscle.value = entry?.muscle_group || '';
  exerciseUi.Equipment.value = entry?.uses_equipment ? entry.equipment : '';
  exerciseUi.UsesEquipment.value = String(entry?.uses_equipment || 0);
  exerciseUi.Tips.value = entry?.tips || '';
  showEquipmentField();
  renderVideoEditor('');
  exerciseUi.CatalogDialog.showModal();
}

exerciseUi.UsesEquipment.addEventListener('change', showEquipmentField);
document.getElementById('btnNewCatalogExercise').addEventListener('click', () => editCatalogExercise());
exerciseUi.CatalogList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-catalog-exercise]');
  if (button) editCatalogExercise(exerciseCatalogEntries.find(({ key }) => key === button.dataset.catalogExercise));
});

async function runExerciseEdit(action) {
  if (exerciseEditor.pending) return;
  exerciseEditor.pending = true;
  renderVideoEditor();
  try {
    await action();
  } catch (err) {
    renderVideoEditor(err.message);
    showToast(err.message, true);
  } finally {
    exerciseEditor.pending = false;
    renderVideoEditor();
  }
}

exerciseUi.EditForm.addEventListener('submit', (event) => {
  event.preventDefault();
  runExerciseEdit(async () => {
    const key = exerciseEditor.current?.key;
    exerciseEditor.current = await api(key ? exerciseApiPath(key) : '/api/exercise-catalog', {
      method: key ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: exerciseUi.Name.value,
        muscle_group: exerciseUi.Muscle.value,
        uses_equipment: exerciseUi.UsesEquipment.value === '1',
        equipment: exerciseUi.Equipment.value,
        tips: exerciseUi.Tips.value,
      }),
    });
    exerciseUi.EditTitle.textContent = 'Editar exercício';
    renderVideoEditor('Exercício salvo. Você pode cadastrar a execução abaixo.');
    await loadExerciseCatalog();
  });
});

function syncTrimLabels() {
  const start = Number(exerciseUi.TrimStart?.value || 0);
  const end = Number(exerciseUi.TrimEnd?.value || 0);
  if (exerciseUi.TrimStartLabel) exerciseUi.TrimStartLabel.textContent = `${start.toFixed(1)}s`;
  if (exerciseUi.TrimEndLabel) exerciseUi.TrimEndLabel.textContent = `${end.toFixed(1)}s`;
  if (exerciseUi.TrimSummary) {
    const dur = Math.max(0, end - start);
    exerciseUi.TrimSummary.textContent = `${start.toFixed(1)}s – ${end.toFixed(1)}s (${dur.toFixed(1)}s)`;
  }
}

function resetVideoEditControls(duration = 0) {
  exerciseEditor.duration = Number(duration) || 0;
  exerciseEditor.editedApplied = false;
  if (exerciseUi.TrimStart) {
    exerciseUi.TrimStart.max = duration ? String(duration.toFixed(1)) : '0';
    exerciseUi.TrimStart.value = '0';
  }
  if (exerciseUi.TrimEnd) {
    exerciseUi.TrimEnd.max = duration ? String(duration.toFixed(1)) : '0';
    exerciseUi.TrimEnd.value = duration ? String(duration.toFixed(1)) : '0';
  }
  if (exerciseUi.VideoRotate) exerciseUi.VideoRotate.value = '0';
  if (exerciseUi.RotateLabel) exerciseUi.RotateLabel.textContent = '0°';
  if (exerciseUi.VideoSpeed) exerciseUi.VideoSpeed.value = '1';
  if (exerciseUi.SpeedLabel) exerciseUi.SpeedLabel.textContent = '1x';
  if (exerciseUi.VideoFlip) exerciseUi.VideoFlip.checked = false;
  if (exerciseUi.FlipBtn) {
    exerciseUi.FlipBtn.setAttribute('aria-pressed', 'false');
    exerciseUi.FlipBtn.classList.remove('btn-primary');
    exerciseUi.FlipBtn.classList.add('btn-secondary');
  }
  syncTrimLabels();
  updatePreviewVisualTransform();
}

function updatePreviewVisualTransform() {
  const preview = exerciseUi.VideoPreview;
  if (!preview) return;
  const rot = Number(exerciseUi.VideoRotate?.value || 0);
  const flip = Boolean(exerciseUi.VideoFlip?.checked);
  const speed = Number(exerciseUi.VideoSpeed?.value || 1);
  preview.playbackRate = speed;
  const parts = [];
  if (rot) parts.push(`rotate(${rot}deg)`);
  if (flip) parts.push('scaleX(-1)');
  preview.style.transform = parts.join(' ');
}

function hasPendingVideoEdits() {
  if (!exerciseEditor.draft || exerciseEditor.editedApplied) return false;
  if (exerciseEditor.draft.size > videoLimit) return true;
  const start = Number(exerciseUi.TrimStart?.value || 0);
  const end = Number(exerciseUi.TrimEnd?.value || 0);
  const dur = Number(exerciseEditor.duration || 0);
  const rot = Number(exerciseUi.VideoRotate?.value || 0);
  const speed = Number(exerciseUi.VideoSpeed?.value || 1);
  const flip = Boolean(exerciseUi.VideoFlip?.checked);
  const trimChanged = dur > 0 && (start > 0.05 || (end > 0 && end < dur - 0.05));
  return trimChanged || rot !== 0 || speed !== 1 || flip;
}

async function renderEditedVideoBlob() {
  const sourceUrl = exerciseEditor.previewUrl;
  if (!sourceUrl) return exerciseEditor.draft;
  const mimeType = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('Navegador não suporta edição local de vídeo.');

  const srcVideo = document.createElement('video');
  srcVideo.src = sourceUrl;
  srcVideo.muted = true;
  srcVideo.playsInline = true;
  srcVideo.setAttribute('webkit-playsinline', 'true');
  await new Promise((resolve, reject) => {
    srcVideo.onloadedmetadata = resolve;
    srcVideo.onerror = () => reject(new Error('Falha ao carregar vídeo para edição.'));
  });

  const dur = Number.isFinite(srcVideo.duration) ? srcVideo.duration : exerciseEditor.duration;
  const start = Math.max(0, Math.min(Number(exerciseUi.TrimStart?.value || 0), dur));
  const rawEnd = Number(exerciseUi.TrimEnd?.value || dur);
  const end = rawEnd > start ? Math.min(rawEnd, dur) : dur;
  if (end - start < 0.2) throw new Error('O trecho selecionado deve ter pelo menos 0,2 segundo.');

  const rot = Number(exerciseUi.VideoRotate?.value || 0);
  const speed = Number(exerciseUi.VideoSpeed?.value || 1);
  const flip = Boolean(exerciseUi.VideoFlip?.checked);
  const rawW = srcVideo.videoWidth || 640;
  const rawH = srcVideo.videoHeight || 480;
  const scale = Math.min(1, 720 / Math.max(rawW, rawH));
  const w = Math.max(2, Math.round((rawW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((rawH * scale) / 2) * 2);
  const swap = rot === 90 || rot === 270;

  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');

  srcVideo.currentTime = start;
  await new Promise((resolve) => { srcVideo.onseeked = resolve; });

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
  const chunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };

  const donePromise = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
  });

  srcVideo.playbackRate = speed;
  recorder.start(250);
  await srcVideo.play();

  await new Promise((resolve) => {
    let rafId = 0;
    const drawFrame = () => {
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(srcVideo, -w / 2, -h / 2, w, h);
      ctx.restore();
      const pct = Math.min(99, Math.max(1, Math.round(((srcVideo.currentTime - start) / Math.max(0.1, end - start)) * 100)));
      if (exerciseUi.VideoStatus) exerciseUi.VideoStatus.textContent = `Processando edição (720p): ${pct}%...`;
      if (srcVideo.currentTime >= end || srcVideo.ended) {
        srcVideo.pause();
        cancelAnimationFrame(rafId);
        resolve();
        return;
      }
      rafId = requestAnimationFrame(drawFrame);
    };
    rafId = requestAnimationFrame(drawFrame);
  });

  if (recorder.state === 'recording') recorder.stop();
  const editedBlob = await donePromise;
  if (editedBlob.size > videoLimit) {
    throw new Error('O vídeo editado passou de 30 MB. Reduza o trecho.');
  }
  return editedBlob;
}

function setVideoDraft(blob) {
  if (exerciseEditor.previewUrl) URL.revokeObjectURL(exerciseEditor.previewUrl);
  exerciseEditor.draft = blob;
  exerciseEditor.previewUrl = blob ? URL.createObjectURL(blob) : null;
  if (!blob) resetVideoEditControls(0);
}

exerciseUi.VideoPreview?.addEventListener('loadedmetadata', () => {
  if (!exerciseEditor.draft || exerciseEditor.stream) return;
  const dur = Number(exerciseUi.VideoPreview.duration);
  if (Number.isFinite(dur) && dur > 0) {
    resetVideoEditControls(dur);
  }
});

exerciseUi.VideoPreview?.addEventListener('timeupdate', () => {
  if (!exerciseEditor.draft || exerciseEditor.stream) return;
  const end = Number(exerciseUi.TrimEnd?.value || 0);
  const start = Number(exerciseUi.TrimStart?.value || 0);
  if (end > start && exerciseUi.VideoPreview.currentTime >= end) {
    exerciseUi.VideoPreview.currentTime = start;
  }
});

exerciseUi.TrimStart?.addEventListener('input', () => {
  const start = Number(exerciseUi.TrimStart.value);
  const end = Number(exerciseUi.TrimEnd.value);
  if (start >= end && end > 0.2) {
    exerciseUi.TrimStart.value = String((end - 0.2).toFixed(1));
  }
  syncTrimLabels();
  if (exerciseUi.VideoPreview && exerciseEditor.draft) {
    exerciseUi.VideoPreview.currentTime = Number(exerciseUi.TrimStart.value);
  }
});

exerciseUi.TrimEnd?.addEventListener('input', () => {
  const start = Number(exerciseUi.TrimStart.value);
  const end = Number(exerciseUi.TrimEnd.value);
  if (end <= start) {
    exerciseUi.TrimEnd.value = String(Math.min(exerciseEditor.duration || start + 0.2, start + 0.2).toFixed(1));
  }
  syncTrimLabels();
});

exerciseUi.RotateBtn?.addEventListener('click', () => {
  const next = (Number(exerciseUi.VideoRotate.value || 0) + 90) % 360;
  exerciseUi.VideoRotate.value = String(next);
  if (exerciseUi.RotateLabel) exerciseUi.RotateLabel.textContent = `${next}°`;
  updatePreviewVisualTransform();
});

exerciseUi.FlipBtn?.addEventListener('click', () => {
  const next = !exerciseUi.VideoFlip.checked;
  exerciseUi.VideoFlip.checked = next;
  exerciseUi.FlipBtn.setAttribute('aria-pressed', String(next));
  exerciseUi.FlipBtn.classList.toggle('btn-primary', next);
  exerciseUi.FlipBtn.classList.toggle('btn-secondary', !next);
  updatePreviewVisualTransform();
});

const SPEED_OPTIONS = ['0.5', '0.75', '1', '1.25', '1.5'];
exerciseUi.SpeedBtn?.addEventListener('click', () => {
  const cur = String(exerciseUi.VideoSpeed.value || '1');
  const next = SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(cur) + 1) % SPEED_OPTIONS.length];
  exerciseUi.VideoSpeed.value = next;
  if (exerciseUi.SpeedLabel) exerciseUi.SpeedLabel.textContent = `${next}x`;
  updatePreviewVisualTransform();
});

exerciseUi.SetStartNow?.addEventListener('click', () => {
  if (exerciseUi.TrimStart) {
    exerciseUi.TrimStart.value = exerciseUi.VideoPreview.currentTime.toFixed(1);
    syncTrimLabels();
  }
});

exerciseUi.SetEndNow?.addEventListener('click', () => {
  if (exerciseUi.TrimEnd) {
    exerciseUi.TrimEnd.value = exerciseUi.VideoPreview.currentTime.toFixed(1);
    syncTrimLabels();
  }
});

exerciseUi.PreviewEdit?.addEventListener('click', () => {
  if (!exerciseEditor.draft) return;
  updatePreviewVisualTransform();
  exerciseUi.VideoPreview.muted = true;
  exerciseUi.VideoPreview.currentTime = Number(exerciseUi.TrimStart?.value || 0);
  exerciseUi.VideoPreview.play().catch(() => {});
});

exerciseUi.ApplyEdit?.addEventListener('click', () => runExerciseEdit(async () => {
  if (!exerciseEditor.draft) return;
  renderVideoEditor('Aplicando corte e compressão (720p)...');
  const editedBlob = await renderEditedVideoBlob();
  setVideoDraft(editedBlob);
  exerciseEditor.editedApplied = true;
  renderVideoEditor(`Edição aplicada (${(editedBlob.size / (1024 * 1024)).toFixed(1)} MB)! Confira e clique em Aprovar e salvar vídeo.`);
}));

exerciseUi.DiscardDraft?.addEventListener('click', () => {
  setVideoDraft(null);
  renderVideoEditor('Rascunho descartado. Você pode gravar ou escolher outro vídeo.');
});

function acceptVideo(blob) {
  if (!blob?.size) return;
  if (blob.size > rawMobileVideoLimit) {
    renderVideoEditor('O vídeo bruto passou de 120 MB. Grave um clipe mais curto.');
    return;
  }
  setVideoDraft(blob);
  const mb = (blob.size / (1024 * 1024)).toFixed(1);
  renderVideoEditor(
    blob.size > videoLimit
      ? `Vídeo com ${mb} MB (acima de 30 MB). Corte o trecho ou toque em Aplicar corte/compressão antes de salvar.`
      : `Vídeo pronto (${mb} MB). Edite se precisar e toque em Aprovar e salvar vídeo.`,
  );
}

for (const input of [exerciseUi.CameraFile, exerciseUi.VideoFile]) {
  input.addEventListener('change', () => {
    acceptVideo(input.files[0]);
    input.value = '';
  });
}
exerciseUi.ChooseVideo.addEventListener('click', () => exerciseUi.VideoFile.click());

function stopCamera() {
  exerciseEditor.stream?.getTracks().forEach((track) => track.stop());
  exerciseEditor.stream = null;
  exerciseUi.VideoPreview.srcObject = null;
  exerciseUi.VideoPreview.muted = false;
}

exerciseUi.Record.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || matchMedia('(pointer: coarse)').matches) {
    exerciseUi.CameraFile.click();
    return;
  }
  await runExerciseEdit(async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    } catch {
      throw new Error('Não foi possível abrir a câmera. Confira a permissão do navegador ou use Escolher vídeo.');
    }
    exerciseEditor.stream = stream;
    try {
      const mimeType = ['video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Use Escolher vídeo para enviar a gravação deste dispositivo.');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
      const chunks = [];
      let size = 0;
      let failed = false;
      recorder.ondataavailable = ({ data }) => {
        size += data.size;
        if (size <= videoLimit) chunks.push(data);
        else if (recorder.state === 'recording') recorder.stop();
      };
      recorder.onerror = () => {
        failed = true;
        renderVideoEditor('A gravação foi interrompida. Use Escolher vídeo para tentar novamente.');
      };
      recorder.onstop = () => {
        if (exerciseEditor.recorder !== recorder) return;
        exerciseEditor.recorder = null;
        stopCamera();
        if (failed || size > videoLimit) {
          renderVideoEditor(failed ? 'Não foi possível concluir a gravação.' : 'O vídeo passou de 30 MB. Grave um clipe mais curto.');
        } else {
          acceptVideo(new Blob(chunks, { type: recorder.mimeType }));
          renderVideoEditor();
        }
      };
      recorder.start(1000);
      exerciseEditor.recorder = recorder;
      exerciseUi.VideoPreview.classList.remove('hidden');
      exerciseUi.VideoPreview.controls = false;
      exerciseUi.VideoPreview.muted = true;
      exerciseUi.VideoPreview.srcObject = stream;
      exerciseUi.VideoPreview.play().catch(() => {});
      renderVideoEditor('Gravando pela câmera, sem áudio.');
    } catch (err) {
      stopCamera();
      throw err;
    }
  });
});
exerciseUi.Stop.addEventListener('click', () => {
  if (exerciseEditor.recorder?.state === 'recording') exerciseEditor.recorder.stop();
});

exerciseUi.SaveVideo.addEventListener('click', () => runExerciseEdit(async () => {
  if (!exerciseEditor.draft || !exerciseEditor.current) return;
  let finalBlob = exerciseEditor.draft;
  if (hasPendingVideoEdits()) {
    renderVideoEditor('Processando edição antes de aprovar...');
    finalBlob = await renderEditedVideoBlob();
  }
  const url = exerciseApiPath(exerciseEditor.current.key) + '/video';
  const result = await api(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: finalBlob,
  });
  exerciseEditor.current.has_video = Number(result.has_video);
  setVideoDraft(null);
  renderVideoEditor('Vídeo salvo nas fichas que usam este exercício.');
  await loadExerciseCatalog();
}));

exerciseUi.RemoveVideo.addEventListener('click', () => {
  if (!confirm('Remover o vídeo deste exercício de todas as fichas?')) return;
  runExerciseEdit(async () => {
    await api(exerciseApiPath(exerciseEditor.current.key) + '/video', { method: 'DELETE' });
    exerciseEditor.current.has_video = 0;
    renderVideoEditor('Vídeo removido.');
    await loadExerciseCatalog();
  });
});

exerciseUi.Close.addEventListener('click', () => exerciseUi.CatalogDialog.close());
exerciseUi.CatalogDialog.addEventListener('cancel', (event) => {
  if (exerciseEditor.pending) event.preventDefault();
});
exerciseUi.CatalogDialog.addEventListener('close', () => {
  if (exerciseEditor.recorder?.state === 'recording') exerciseEditor.recorder.stop();
  exerciseEditor.recorder = null;
  stopCamera();
  setVideoDraft(null);
  exerciseEditor.current = null;
  renderVideoEditor('');
});
