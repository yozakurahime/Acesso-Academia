import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Registra atalhos globais no Windows (F9 e Ctrl+Alt+L) para liberar a catraca
 * mesmo quando o navegador estiver minimizado ou em segundo plano.
 */
export function startGlobalHotkey(rootDir, port, token) {
  if (process.platform !== 'win32') return null;

  const scriptPath = path.join(rootDir, 'scripts', 'hotkey-listener.ps1');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Port', String(port), '-ServerPid', String(process.pid)],
    { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
      env: { ...process.env, OXIGENIO_HOTKEY_TOKEN: token } },
  );

  child.on('error', (err) => {
    console.warn('[ATALHO GLOBAL] Não foi possível iniciar listener:', err.message);
  });

  const cleanup = () => {
    if (!child.killed) {
      child.kill();
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  child.on('exit', (code) => {
    if (code) console.warn(`[ATALHO GLOBAL] Listener encerrou com código ${code}.`);
  });
  return child;
}
