(() => {
  const modalitySelect = document.getElementById('modalitySelect');
  const classWrap = document.getElementById('classWrap');
  const classSelect = document.getElementById('classSelect');
  const modalityNotice = document.getElementById('modalityNotice');
  const planWrap = document.getElementById('planWrap');
  const planSelect = document.getElementById('planSelect');
  const docWrap = document.getElementById('docWrap');
  const docInput = document.getElementById('docInput');
  const kidsWrap = document.getElementById('kidsWrap');
  const photoSection = document.getElementById('photoSection');
  const openCameraBtn = document.getElementById('openCameraBtn');
  const uploadPhotoBtn = document.getElementById('uploadPhotoBtn');
  const captureBtn = document.getElementById('captureBtn');
  const photoFileInput = document.getElementById('photoFileInput');
  const cameraVideo = document.getElementById('cameraVideo');
  const photoPreview = document.getElementById('photoPreview');
  const enrollForm = document.getElementById('enrollForm');
  const formError = document.getElementById('formError');
  const submitBtn = document.getElementById('submitBtn');
  const resultCard = document.getElementById('resultCard');
  const resultTitle = document.getElementById('resultTitle');
  const resultMessage = document.getElementById('resultMessage');
  const pixArea = document.getElementById('pixArea');
  const pixQrImg = document.getElementById('pixQrImg');
  const pixCopy = document.getElementById('pixCopy');
  const copyPixBtn = document.getElementById('copyPixBtn');
  const pixStatusText = document.getElementById('pixStatusText');
  const whatsappFallbackBtn = document.getElementById('whatsappFallbackBtn');

  let optionsData = { plans: [], modalities: [], classes: [] };
  let capturedBase64 = null;
  let mediaStream = null;
  let pixPollTimer = null;

  function formatMoney(cents) {
    return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function isKidsSwimText(text) {
    const s = String(text || '').toLowerCase();
    return (s.includes('nata') || s.includes('baby')) && (s.includes('infantil') || s.includes('baby') || s.includes('crian'));
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    cameraVideo.hidden = true;
    captureBtn.hidden = true;
  }

  function compressImageToBase64(imgEl) {
    const maxDim = 640;
    const w = imgEl.videoWidth || imgEl.naturalWidth || 480;
    const h = imgEl.videoHeight || imgEl.naturalHeight || 480;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.84);
  }

  function showFormError(msg) {
    formError.hidden = false;
    formError.textContent = msg;
  }

  function clearFormError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  function updateModeUI() {
    clearFormError();
    const modId = Number(modalitySelect.value || 0);
    const mod = optionsData.modalities.find((m) => Number(m.id) === modId);
    const modClasses = optionsData.classes.filter((c) => Number(c.modality_id) === modId);
    const modName = mod?.name || '';

    classSelect.innerHTML = '';
    if (modClasses.length > 0) {
      classWrap.hidden = false;
      for (const c of modClasses) {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        if (c.allow_new_enrollments === 0) {
          opt.textContent = `${c.name} (${c.schedule}) — Turma fechada para novas matrículas`;
          opt.disabled = true;
        } else if (c.online_enrollment_mode === 'reception_only') {
          opt.textContent = `${c.name} (${c.schedule}) — Confirmar vaga na recepção`;
        } else if (c.spots_left === 0) {
          opt.textContent = `${c.name} (${c.schedule}) — Lotada`;
          opt.disabled = true;
        } else {
          opt.textContent = `${c.name} (${c.schedule}) — ${c.spots_left} vaga(s)`;
        }
        classSelect.appendChild(opt);
      }
      const firstEnabled = Array.from(classSelect.options).find((o) => !o.disabled);
      if (firstEnabled) classSelect.value = firstEnabled.value;
    } else {
      classWrap.hidden = true;
    }

    const selectedClass = modClasses.find((c) => String(c.id) === classSelect.value) || null;
    const receptionOnly = isKidsSwimText(modName) || selectedClass?.online_enrollment_mode === 'reception_only';
    const allClosed = modClasses.length > 0 && modClasses.every((c) => c.allow_new_enrollments === 0 || (c.online_enrollment_mode !== 'reception_only' && c.spots_left === 0));

    if (receptionOnly) {
      modalityNotice.hidden = false;
      modalityNotice.textContent = 'Para Natação Infantil e Baby, a vaga precisa ser confirmada pela recepção/professor antes do pagamento.';
      planWrap.hidden = true;
      planSelect.required = false;
      docWrap.hidden = true;
      docInput.required = false;
      kidsWrap.hidden = false;
      photoSection.hidden = true;
      submitBtn.textContent = 'Solicitar Confirmação de Vaga';
      submitBtn.disabled = false;
    } else if (allClosed) {
      modalityNotice.hidden = false;
      modalityNotice.textContent = 'As turmas desta modalidade estão fechadas ou lotadas no momento. Fale com nossa recepção no WhatsApp (62) 98102-0169.';
      planWrap.hidden = true;
      planSelect.required = false;
      docWrap.hidden = true;
      docInput.required = false;
      kidsWrap.hidden = true;
      photoSection.hidden = true;
      submitBtn.disabled = true;
    } else {
      modalityNotice.hidden = true;
      planWrap.hidden = false;
      planSelect.required = (optionsData.plans || []).length > 0;
      docWrap.hidden = false;
      docInput.required = true;
      kidsWrap.hidden = true;
      photoSection.hidden = false;
      submitBtn.textContent = 'Concluir Matrícula e Gerar PIX';
      submitBtn.disabled = false;
    }
  }

  async function loadOptions() {
    try {
      const res = await fetch('/api/public/enrollment-options');
      if (!res.ok) throw new Error('Falha ao carregar opções.');
      const data = await res.json();
      optionsData = data;

      modalitySelect.innerHTML = '';
      for (const m of data.modalities || []) {
        const opt = document.createElement('option');
        opt.value = String(m.id);
        opt.textContent = m.name;
        modalitySelect.appendChild(opt);
      }

      const musc = (data.modalities || []).find((m) => m.name.toLowerCase().includes('muscula'));
      if (musc) modalitySelect.value = String(musc.id);

      planSelect.innerHTML = '';
      for (const p of data.plans || []) {
        const opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = `${p.name} — ${formatMoney(p.price_cents)} (${p.duration_days} dias)`;
        planSelect.appendChild(opt);
      }

      updateModeUI();
    } catch {
      formError.hidden = false;
      formError.textContent = 'Não foi possível carregar os planos e modalidades.';
    }
  }

  modalitySelect.addEventListener('change', updateModeUI);
  classSelect.addEventListener('change', updateModeUI);

  openCameraBtn.addEventListener('click', async () => {
    clearFormError();
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      showFormError('Seu navegador não suporta acesso à câmera. Use o botão "Enviar / Tirar Foto".');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      cameraVideo.srcObject = mediaStream;
      cameraVideo.hidden = false;
      captureBtn.hidden = false;
    } catch {
      showFormError('Não foi possível acessar a câmera. Use o botão "Enviar / Tirar Foto".');
    }
  });

  uploadPhotoBtn?.addEventListener('click', () => {
    clearFormError();
    photoFileInput.click();
  });

  captureBtn.addEventListener('click', () => {
    capturedBase64 = compressImageToBase64(cameraVideo);
    photoPreview.src = capturedBase64;
    photoPreview.hidden = false;
    stopCamera();
  });

  photoFileInput.addEventListener('change', () => {
    const file = photoFileInput.files?.[0];
    if (!file) return;
    clearFormError();
    const reader = new FileReader();
    reader.onerror = () => {
      showFormError('Não foi possível ler o arquivo selecionado. Tente outra imagem.');
      photoFileInput.value = '';
    };
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => {
        showFormError('Arquivo inválido. Selecione uma foto nos formatos JPG, PNG ou WEBP.');
        photoFileInput.value = '';
      };
      img.onload = () => {
        capturedBase64 = compressImageToBase64(img);
        photoPreview.src = capturedBase64;
        photoPreview.hidden = false;
        stopCamera();
        photoFileInput.value = '';
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });

  copyPixBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pixCopy.textContent || '');
      copyPixBtn.textContent = 'Código PIX copiado!';
      setTimeout(() => {
        copyPixBtn.textContent = 'Copiar Código PIX';
      }, 2500);
    } catch {
      copyPixBtn.textContent = 'Selecione e copie o código acima';
    }
  });

  function startPixPolling(chargeId) {
    if (pixPollTimer) clearInterval(pixPollTimer);
    let attempts = 0;
    pixPollTimer = setInterval(async () => {
      attempts += 1;
      if (attempts > 120) {
        clearInterval(pixPollTimer);
        pixPollTimer = null;
        return;
      }
      try {
        const res = await fetch(`/api/public/pix/${chargeId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'paid') {
          clearInterval(pixPollTimer);
          pixPollTimer = null;
          pixStatusText.textContent = '✅ Pagamento confirmado! Seu acesso na catraca já está liberado.';
          pixStatusText.style.color = '#4ade80';
        } else if (data.status === 'expired' || data.status === 'cancelled') {
          clearInterval(pixPollTimer);
          pixPollTimer = null;
          pixStatusText.textContent = 'Cobrança PIX expirada ou cancelada. Recarregue a página para gerar um novo código.';
          pixStatusText.style.color = '#f87171';
        }
      } catch {}
    }, 5000);
  }

  window.addEventListener('pagehide', () => {
    stopCamera();
    if (pixPollTimer) {
      clearInterval(pixPollTimer);
      pixPollTimer = null;
    }
  });

  enrollForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormError();

    const nameInput = document.getElementById('nameInput');
    const phoneInput = document.getElementById('phoneInput');
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const phoneDigits = phone.replace(/\D/g, '');
    const docValue = docInput.value.trim();
    const docDigits = docValue.replace(/\D/g, '');
    const planId = !planWrap.hidden && planSelect.value ? Number(planSelect.value) : null;

    if (name.length < 3) {
      showFormError('Informe seu nome completo.');
      nameInput.focus();
      return;
    }
    if (phoneDigits.length < 10 || phoneDigits.length > 13) {
      showFormError('Informe um WhatsApp válido com DDD.');
      phoneInput.focus();
      return;
    }
    if (!docWrap.hidden && docDigits.length !== 11) {
      showFormError('Informe um CPF válido com 11 dígitos.');
      docInput.focus();
      return;
    }
    if (!planWrap.hidden && !planId) {
      showFormError('Selecione um plano para continuar.');
      planSelect.focus();
      return;
    }

    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    const mod = optionsData.modalities.find((m) => String(m.id) === modalitySelect.value);
    const payload = {
      name,
      phone,
      document: docValue,
      birth_date: document.getElementById('birthInput').value || null,
      modality_id: Number(modalitySelect.value) || null,
      modality_name: mod?.name || '',
      class_id: !classWrap.hidden && classSelect.value ? Number(classSelect.value) : null,
      plan_id: planId,
      child_age: document.getElementById('childAgeInput').value.trim() || null,
      preferred_schedule: document.getElementById('prefScheduleInput').value.trim() || null,
      photo_base64: !photoSection.hidden ? capturedBase64 : null,
      source: 'site',
    };

    try {
      const res = await fetch('/api/public/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ao enviar cadastro.');

      stopCamera();
      enrollForm.hidden = true;
      resultCard.hidden = false;
      resultMessage.textContent = data.message || 'Concluído!';

      if (data.mode === 'request') {
        resultTitle.textContent = 'Solicitação de Vaga Enviada';
        pixArea.hidden = true;
        const text = encodeURIComponent(
          `Olá! Enviei uma solicitação de vaga para ${payload.modality_name} no site. Nome: ${payload.name}${payload.child_age ? `, Idade: ${payload.child_age}` : ''}${payload.preferred_schedule ? `, Horário: ${payload.preferred_schedule}` : ''}.`
        );
        whatsappFallbackBtn.href = `https://wa.me/5562981020169?text=${text}`;
        whatsappFallbackBtn.hidden = false;
      } else {
        resultTitle.textContent = 'Matrícula Criada!';
        if (data.pixCharge && (data.pixCharge.qr_code || data.pixCharge.qr_code_base64)) {
          pixArea.hidden = false;
          const qrB64 = String(data.pixCharge.qr_code_base64 || '');
          if (qrB64) {
            pixQrImg.src = qrB64.startsWith('data:image/')
              ? qrB64
              : `data:image/png;base64,${qrB64}`;
            pixQrImg.hidden = false;
          }
          pixCopy.textContent = data.pixCharge.qr_code || '';
          if (data.pixCharge.id) startPixPolling(data.pixCharge.id);
        } else {
          pixArea.hidden = true;
          const text = encodeURIComponent(`Olá! Acabei de fazer meu cadastro de ${payload.modality_name} no site (${payload.name}) e gostaria de concluir o pagamento.`);
          whatsappFallbackBtn.href = `https://wa.me/5562981020169?text=${text}`;
          whatsappFallbackBtn.hidden = false;
        }
      }
    } catch (err) {
      showFormError(err.message || 'Erro ao enviar cadastro.');
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  });

  loadOptions();
})();
