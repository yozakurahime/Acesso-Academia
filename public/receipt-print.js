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
        <div class="rcp-item-main">
          <div class="rcp-item-name">${esc(it.title)}</div>
          <div class="rcp-item-detail">${esc(it.detail || '1x')}</div>
        </div>
        <div class="rcp-item-price">${money(it.amountCents)}</div>
      </div>
    `).join('');

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Recibo #${esc(receiptNumber)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; color: #000; }
    html, body {
      margin: 0;
      padding: 0;
      width: 72mm;
      background: #fff;
      font-family: 'Segoe UI', 'Inter', Arial, Helvetica, sans-serif;
      font-size: 11.5px;
      line-height: 1.4;
      font-variant-numeric: tabular-nums;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .rcp-wrap {
      width: 72mm;
      padding: 3.5mm 2.5mm 14mm 2.5mm;
    }
    .rcp-header {
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid #000;
    }
    .rcp-brand {
      font-size: 15.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      line-height: 1.2;
    }
    .rcp-phone {
      font-size: 10.5px;
      font-weight: 600;
      margin-top: 2px;
    }
    .rcp-badge {
      display: inline-block;
      margin-top: 6px;
      padding: 2.5px 8px;
      background: #000;
      color: #fff !important;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      border-radius: 3px;
    }
    .rcp-nonfiscal {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.3px;
      margin-top: 4px;
      text-transform: uppercase;
    }
    .rcp-meta {
      padding: 7px 0;
      border-bottom: 1px dashed #000;
    }
    .rcp-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin: 2px 0;
    }
    .rcp-label {
      font-size: 10.5px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .rcp-val {
      text-align: right;
      word-break: break-word;
    }
    .rcp-items {
      padding: 6px 0;
      border-bottom: 1px dashed #000;
    }
    .rcp-section-label {
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .rcp-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      padding: 3px 0;
    }
    .rcp-item-name {
      font-weight: 700;
      font-size: 12px;
    }
    .rcp-item-detail {
      font-size: 10.5px;
    }
    .rcp-item-price {
      font-weight: 800;
      font-size: 12px;
      white-space: nowrap;
    }
    .rcp-validity {
      margin-top: 7px;
      padding: 5px 8px;
      border: 1.5px solid #000;
      border-radius: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }
    .rcp-total-box {
      margin-top: 7px;
      border: 2px solid #000;
      border-radius: 4px;
      overflow: hidden;
    }
    .rcp-total-top {
      background: #000;
      color: #fff !important;
      padding: 6px 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .rcp-total-top span {
      color: #fff !important;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
    }
    .rcp-total-top strong {
      color: #fff !important;
      font-size: 16px;
      font-weight: 800;
    }
    .rcp-total-method {
      padding: 5px 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }
    .rcp-extra {
      margin-top: 6px;
      font-size: 10.5px;
    }
    .rcp-foot {
      margin-top: 10px;
      padding-top: 7px;
      border-top: 1px dashed #000;
      text-align: center;
      font-size: 10.5px;
    }
  </style>
</head>
<body>
  <div class="rcp-wrap">
    <div class="rcp-header">
      <div class="rcp-brand">${esc(gymName)}</div>
      ${gymPhone ? `<div class="rcp-phone">WhatsApp: ${esc(gymPhone)}</div>` : ''}
      <div class="rcp-badge">Recibo de ${esc(kind)}</div>
      <div class="rcp-nonfiscal">Comprovante sem valor fiscal</div>
    </div>

    <div class="rcp-meta">
      <div class="rcp-row"><span class="rcp-label">Recibo</span><strong class="rcp-val">#${esc(receiptNumber)}</strong></div>
      <div class="rcp-row"><span class="rcp-label">Data</span><span class="rcp-val">${esc(issuedAt)}</span></div>
      <div class="rcp-row"><span class="rcp-label">Cliente</span><strong class="rcp-val">${esc(customerName)}</strong></div>
      ${customerDoc ? `<div class="rcp-row"><span class="rcp-label">CPF</span><span class="rcp-val">${esc(customerDoc)}</span></div>` : ''}
    </div>

    <div class="rcp-items">
      <div class="rcp-section-label">Descrição</div>
      ${itemRows}
    </div>

    ${validUntil ? `<div class="rcp-validity"><span>Validade do plano</span><strong>${esc(validUntil)}</strong></div>` : ''}

    <div class="rcp-total-box">
      <div class="rcp-total-top">
        <span>TOTAL PAGO</span>
        <strong>${money(totalCents)}</strong>
      </div>
      <div class="rcp-total-method">
        <span>Forma de pagamento</span>
        <strong>${esc(paymentMethod)}</strong>
      </div>
    </div>

    ${operatorName || notes ? `
      <div class="rcp-extra">
        ${operatorName ? `<div class="rcp-row"><span class="rcp-label">Atendente</span><span class="rcp-val">${esc(operatorName)}</span></div>` : ''}
        ${notes ? `<div style="margin-top:3px;"><strong>Obs.:</strong> ${esc(notes)}</div>` : ''}
      </div>
    ` : ''}

    <div class="rcp-foot">
      <div><strong>Obrigado pela preferência!</strong></div>
      <div>Bons treinos!</div>
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
