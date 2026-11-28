import { execFile } from 'node:child_process';

const METHOD_LABELS = {
  pix: 'Pix',
  credit: 'Cartao de Credito',
  debit: 'Cartao de Debito',
  cash: 'Dinheiro',
  card: 'Cartao',
  split: 'Dividido',
  debt: 'Fiado / Debito',
};

const CP850_MAP = {
  'ç': 0x87, 'Ç': 0x80,
  'á': 0xa0, 'à': 0x85, 'â': 0x83, 'ã': 0xc6, 'ä': 0x84,
  'Á': 0xb5, 'À': 0xb7, 'Â': 0xb6, 'Ã': 0xc7, 'Ä': 0x8e,
  'é': 0x82, 'è': 0x8a, 'ê': 0x88, 'ë': 0x89,
  'É': 0x90, 'È': 0xd4, 'Ê': 0xd2, 'Ë': 0xd3,
  'í': 0xa1, 'ì': 0x8d, 'î': 0x8c, 'ï': 0x8b,
  'Í': 0xd6, 'Ì': 0xde, 'Î': 0xd7, 'Ï': 0xd8,
  'ó': 0xa2, 'ò': 0x95, 'ô': 0x93, 'õ': 0xe4, 'ö': 0x94,
  'Ó': 0xe0, 'Ò': 0xe3, 'Ô': 0xe2, 'Õ': 0xe5, 'Ö': 0x99,
  'ú': 0xa3, 'ù': 0x97, 'û': 0x96, 'ü': 0x81,
  'Ú': 0xe9, 'Ù': 0xeb, 'Û': 0xea, 'Ü': 0x9a,
  'º': 0xa7, 'ª': 0xa6, '°': 0xf8,
};

function encodeCp850(text) {
  const str = String(text ?? '');
  const out = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
    } else if (ch === '\n' || ch === '\r') {
      out.push(code);
    } else if (Object.hasOwn(CP850_MAP, ch)) {
      out.push(CP850_MAP[ch]);
    } else {
      const ascii = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const a of ascii) {
        const ac = a.charCodeAt(0);
        out.push(ac >= 0x20 && ac <= 0x7e ? ac : 0x20);
      }
    }
  }
  return Buffer.from(out);
}

function formatMoneyBr(cents) {
  const val = (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
  return `R$ ${val}`;
}

function formatDateBr(isoOrDateTime) {
  const raw = String(isoOrDateTime || '').trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!m) return raw;
  return m[4] ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

function padLine(left, right, width = 42) {
  const l = String(left || '').trim();
  const r = String(right || '').trim();
  const space = width - l.length - r.length;
  if (space >= 1) return `${l}${' '.repeat(space)}${r}`;
  return `${l.slice(0, Math.max(1, width - r.length - 1))} ${r}`;
}

export function buildPaymentReceiptPayload(store, payment, member = null) {
  const settings = typeof store?.getSettings === 'function' ? store.getSettings() : {};
  const gymName = /^(Minha Academia|Academia Oxigenio)$/i.test(settings.gym_name || '')
    ? 'Academia Oxigênio'
    : (settings.gym_name || 'Academia Oxigênio');
  const resolvedMember = member || (payment?.member_id && store?.get
    ? store.get('SELECT id, name, document, valid_until FROM members WHERE id = ?', [payment.member_id])
    : null);
  const plan = payment?.plan_id && store?.get
    ? store.get('SELECT id, name, duration_days FROM plans WHERE id = ?', [payment.plan_id])
    : null;
  const staff = payment?.staff_id && store?.get
    ? store.get('SELECT name FROM staff_members WHERE id = ?', [payment.staff_id])
    : null;

  return {
    gymName,
    gymPhone: settings.gym_phone || '',
    receiptNumber: String(payment?.id || '-').padStart(6, '0'),
    issuedAt: formatDateBr(payment?.paid_at || new Date().toISOString()),
    kind: 'RECIBO DE MENSALIDADE',
    customerName: payment?.member_name || resolvedMember?.name || 'Aluno',
    customerDoc: resolvedMember?.document || '',
    itemTitle: payment?.plan_name || plan?.name || 'Mensalidade / Plano',
    itemDetail: plan?.duration_days ? `${plan.duration_days} dias` : '1x',
    totalCents: Number(payment?.amount_cents || 0),
    paymentMethod: METHOD_LABELS[String(payment?.method || '').toLowerCase()] || String(payment?.method || '-'),
    validUntil: formatDateBr(resolvedMember?.valid_until || ''),
    operatorName: payment?.staff_name || staff?.name || '',
  };
}

export function buildEscPosReceiptBuffer(receipt = {}) {
  const width = 42;
  const sep = '-'.repeat(width);
  const chunks = [
    Buffer.from([0x1b, 0x40]), // ESC @
    Buffer.from([0x1b, 0x74, 0x02]), // ESC t 2 (CP850)
    Buffer.from([0x1b, 0x61, 0x01]), // center
    Buffer.from([0x1b, 0x45, 0x01]), // bold on
    encodeCp850(`${String(receipt.gymName || 'ACADEMIA OXIGENIO').toUpperCase()}\n`),
    Buffer.from([0x1b, 0x45, 0x00]), // bold off
    encodeCp850(`${receipt.kind || 'RECIBO DE MENSALIDADE'}\n`),
    encodeCp850('COMPROVANTE SEM VALOR FISCAL\n'),
    Buffer.from([0x1b, 0x61, 0x00]), // left
    encodeCp850(`${sep}\n`),
    encodeCp850(`${padLine('Recibo', `#${receipt.receiptNumber || '-'}`, width)}\n`),
    encodeCp850(`${padLine('Data', receipt.issuedAt || '', width)}\n`),
    encodeCp850(`${padLine('Cliente', receipt.customerName || 'Aluno', width)}\n`),
  ];
  if (receipt.customerDoc) {
    chunks.push(encodeCp850(`${padLine('CPF', receipt.customerDoc, width)}\n`));
  }
  chunks.push(encodeCp850(`${sep}\n`));
  chunks.push(Buffer.from([0x1b, 0x45, 0x01]));
  chunks.push(encodeCp850(`${padLine(receipt.itemTitle || 'Mensalidade', formatMoneyBr(receipt.totalCents), width)}\n`));
  chunks.push(Buffer.from([0x1b, 0x45, 0x00]));
  if (receipt.itemDetail) {
    chunks.push(encodeCp850(`${receipt.itemDetail}\n`));
  }
  if (receipt.validUntil) {
    chunks.push(encodeCp850(`${sep}\n`));
    chunks.push(Buffer.from([0x1b, 0x45, 0x01]));
    chunks.push(encodeCp850(`${padLine('Validade do plano', receipt.validUntil, width)}\n`));
    chunks.push(Buffer.from([0x1b, 0x45, 0x00]));
  }
  chunks.push(encodeCp850(`${sep}\n`));
  chunks.push(Buffer.from([0x1b, 0x45, 0x01]));
  chunks.push(encodeCp850(`${padLine('TOTAL PAGO', formatMoneyBr(receipt.totalCents), width)}\n`));
  chunks.push(Buffer.from([0x1b, 0x45, 0x00]));
  chunks.push(encodeCp850(`${padLine('Forma de pagamento', receipt.paymentMethod || '-', width)}\n`));
  if (receipt.operatorName) {
    chunks.push(encodeCp850(`${padLine('Operador', receipt.operatorName, width)}\n`));
  }
  chunks.push(encodeCp850(`${sep}\n`));
  chunks.push(Buffer.from([0x1b, 0x61, 0x01])); // center
  chunks.push(encodeCp850('Obrigado pela preferencia!\n'));
  chunks.push(encodeCp850('Bons treinos!\n'));
  if (receipt.gymPhone) {
    chunks.push(encodeCp850(`WhatsApp: ${receipt.gymPhone}\n`));
  }
  chunks.push(Buffer.from([0x1b, 0x61, 0x00])); // left
  chunks.push(encodeCp850('\n\n\n\n'));
  chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V 66 0 (cut)
  return Buffer.concat(chunks);
}

const WIN_RAW_PRINT_PS = `
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
$payload = $raw | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($payload.dataBase64)
$printerName = $payload.printerName
if (-not $printerName) {
  $def = Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1
  if ($def) { $printerName = $def.Name }
}
if (-not $printerName) { throw "Nenhuma impressora configurada." }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes) {
    IntPtr hPrinter = IntPtr.Zero;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Recibo Academia Oxigenio";
    di.pDataType = "RAW";
    if (!OpenPrinter(szPrinterName.Normalize(), out hPrinter, IntPtr.Zero)) return false;
    bool success = false;
    if (StartDocPrinter(hPrinter, 1, di)) {
      if (StartPagePrinter(hPrinter)) {
        IntPtr unmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, unmanagedBytes, bytes.Length);
        int written = 0;
        success = WritePrinter(hPrinter, unmanagedBytes, bytes.Length, out written);
        Marshal.FreeCoTaskMem(unmanagedBytes);
        EndPagePrinter(hPrinter);
      }
      EndDocPrinter(hPrinter);
    }
    ClosePrinter(hPrinter);
    return success;
  }
}
"@

if (-not [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)) {
  $def = Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1
  if ($def -and $def.Name -ne $printerName -and [RawPrinterHelper]::SendBytesToPrinter($def.Name, $bytes)) {
    exit 0
  }
  throw "Falha ao imprimir na impressora '$printerName'."
}
`;

export function printReceiptToWindowsPrinter(receipt, { printerName = process.env.EDGE_PRINTER_NAME || 'MP-4200 TH' } = {}) {
  const isTestRunner =
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes('--test') ||
    process.argv.some((arg) => /(?:^|[\\/])tests[\\/]|run-tests\.mjs$/i.test(String(arg)));
  if (isTestRunner || process.env.OXIGENIO_DISABLE_PRINTER === '1') {
    return Promise.resolve({ ok: false, skipped: true, reason: 'test_env' });
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, skipped: true, reason: 'not_win32' });
  }
  const buffer = buildEscPosReceiptBuffer(receipt);
  const payloadJson = JSON.stringify({
    printerName: String(printerName || '').trim(),
    dataBase64: buffer.toString('base64'),
  });

  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_RAW_PRINT_PS],
      { timeout: 10000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve({ ok: true, printerName });
      },
    );
    child.stdin?.write(payloadJson);
    child.stdin?.end();
  });
}
