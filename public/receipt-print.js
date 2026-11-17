(function (global) {
  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function buildReceiptHtml({
    gymName = 'Academia Oxigênio',
    gymPhone = '',
    receiptNumber = '-',
    issuedAt = new Date().toLocaleString('pt-BR'),
    kind = 'MENSALIDADE',
    customerName = 'Consumidor',
    customerDoc = '',
    items = [],
    totalCents = 0,
    paymentMethod = '-',
    validUntil = '',
    operatorName = '',
    notes = '',
  }) {
    const itemRows = (items || []).map((it) => `
      <div class="rcp-item">
        <div class="rcp-item-name">${esc(it.title)}</div>
        <div class="rcp-row">
          <span>${esc(it.detail || '1x')}</span>
          <strong>${money(it.amountCents)}</strong>
        </div>
      </div>
    `).join('');

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Recibo #${esc(receiptNumber)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; color: #000 !important; background: #fff !important; }
    html, body {
      margin: 0;
      padding: 0;
      width: 72mm;
      font-family: 'Consolas', 'Lucida Console', 'Courier New', monospace;
      font-size: 11.5px;
      line-height: 1.35;
      -webkit-print-color-adjust: exact;
    }
    .rcp-wrap {
      width: 72mm;
      padding: 3mm 2mm 14mm 2mm;
    }
    .rcp-center { text-align: center; }
    .rcp-title { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.3px; }
    .rcp-sub { font-size: 10.5px; font-weight: 700; margin-top: 2px; }
    .rcp-sep { border-top: 1px dashed #000; margin: 6px 0; }
    .rcp-sep-solid { border-top: 2px solid #000; margin: 6px 0; }
    .rcp-row { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }
    .rcp-item { margin: 4px 0; }
    .rcp-item-name { font-weight: 700; }
    .rcp-total-box {
      border: 1.5px solid #000;
      padding: 5px 6px;
      margin: 6px 0;
    }
    .rcp-total-row {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      font-weight: 800;
    }
    .rcp-foot {
      text-align: center;
      font-size: 10.5px;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="rcp-wrap">
    <div class="rcp-center">
      <div class="rcp-title">${esc(gymName)}</div>
      ${gymPhone ? `<div class="rcp-sub">Tel/WhatsApp: ${esc(gymPhone)}</div>` : ''}
      <div class="rcp-sub">RECIBO DE ${esc(kind)} · NÃO FISCAL</div>
    </div>

    <div class="rcp-sep-solid"></div>

    <div class="rcp-row"><span>Recibo:</span><strong>#${esc(receiptNumber)}</strong></div>
    <div class="rcp-row"><span>Emissão:</span><span>${esc(issuedAt)}</span></div>
    <div class="rcp-row"><span>Cliente:</span><strong>${esc(customerName)}</strong></div>
    ${customerDoc ? `<div class="rcp-row"><span>CPF:</span><span>${esc(customerDoc)}</span></div>` : ''}

    <div class="rcp-sep"></div>

    ${itemRows}

    ${validUntil ? `<div class="rcp-row" style="margin-top:4px;"><span>Nova validade:</span><strong>${esc(validUntil)}</strong></div>` : ''}

    <div class="rcp-total-box">
      <div class="rcp-total-row">
        <span>TOTAL PAGO</span>
        <span>${money(totalCents)}</span>
      </div>
      <div class="rcp-row" style="margin-top:3px;">
        <span>Forma pgto:</span>
        <strong>${esc(paymentMethod)}</strong>
      </div>
    </div>

    ${operatorName ? `<div class="rcp-row"><span>Atendente:</span><span>${esc(operatorName)}</span></div>` : ''}
    ${notes ? `<div style="margin-top:4px;font-size:10.5px;">Obs: ${esc(notes)}</div>` : ''}

    <div class="rcp-sep"></div>
    <div class="rcp-foot">
      <div><strong>Obrigado pela preferência!</strong></div>
      <div>Bom treino!</div>
      <div style="margin-top:4px;">Impressão térmica 80mm · MP-4200</div>
    </div>
  </div>
</body>
</html>`;
  }

  function printReceiptHtml(html) {
    let frame = document.getElementById('mp4200PrintFrame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'mp4200PrintFrame';
      frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
      document.body.appendChild(frame);
    }
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    setTimeout(() => {
      if (!frame.contentWindow) return;
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 120);
  }

  global.MP4200_RECEIPT = {
    buildReceiptHtml,
    printReceiptHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
