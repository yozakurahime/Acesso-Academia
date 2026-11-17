import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const DEFAULT_INTERVAL_MS = 60_000;
const CRASH_RESTART_DELAY_MS = 3_000;
const STOP_TIMEOUT_MS = 4_000;

function appendLog(line) {
  const stamp = new Date().toISOString();
  const formatted = `[${stamp}] [EdgeRunner] ${line}`;
  console.log(formatted);
  try {
    const logDir = path.join(ROOT_DIR, 'data');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'edge-runner.log'), `${formatted}\n`);
  } catch {
    // ignore log write errors
  }
}

export function execAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: ROOT_DIR,
        timeout: 30_000,
        windowsHide: true,
        ...options
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      }
    );
  });
}

export async function checkAndApplyGitUpdate({
  branch = process.env.EDGE_AUTO_UPDATE_BRANCH || 'main',
  runCmd = execAsync
} = {}) {
  if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
    return { updated: false, reason: 'no_git' };
  }

  await runCmd('git', ['fetch', '--quiet', 'origin', branch], { timeout: 20_000 });
  const { stdout: localHead } = await runCmd('git', ['rev-parse', 'HEAD']);
  const { stdout: remoteHead } = await runCmd('git', ['rev-parse', `origin/${branch}`]);

  if (!localHead || !remoteHead || localHead === remoteHead) {
    return { updated: false, reason: 'up_to_date', localHead, remoteHead };
  }

  await runCmd('git', ['pull', '--ff-only', 'origin', branch], { timeout: 30_000 });
  const { stdout: newHead } = await runCmd('git', ['rev-parse', 'HEAD']);
  const { stdout: changedRaw } = await runCmd('git', ['diff', '--name-only', localHead, newHead]);
  const changedFiles = changedRaw
    ? changedRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];

  const depsChanged = changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json');
  if (depsChanged) {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runCmd(npmCmd, ['install', '--omit=dev'], {
      timeout: 120_000,
      shell: process.platform === 'win32'
    });
  }

  const selfChanged = changedFiles.includes('src/edge-runner.js');
  return {
    updated: true,
    oldHead: localHead,
    newHead,
    changedFiles,
    depsChanged,
    selfChanged
  };
}

export class EdgeRunner {
  constructor(options = {}) {
    this.intervalMs = Math.max(
      15_000,
      Number(options.intervalMs || process.env.EDGE_AUTO_UPDATE_MS || DEFAULT_INTERVAL_MS)
    );
    this.enabled = (process.env.EDGE_AUTO_UPDATE || '1') !== '0';
    this.child = null;
    this.stopping = false;
    this.restarting = false;
    this.updating = false;
    this.timer = null;
  }

  start() {
    appendLog(`Iniciando supervisor (auto-update=${this.enabled ? `${Math.round(this.intervalMs / 1000)}s` : 'desativado'})`);
    this.spawnServer();

    if (this.enabled) {
      this.timer = setInterval(() => {
        this.pollUpdate().catch((err) => {
          appendLog(`Erro inesperado no auto-update: ${err.message}`);
        });
      }, this.intervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  spawnServer() {
    if (this.stopping) return;
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env
    });
    this.child = child;
    appendLog(`Servidor iniciado (PID ${child.pid})`);

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping || this.restarting) return;
      appendLog(`Servidor encerrou inesperadamente (code=${code}, signal=${signal}). Reiniciando em ${CRASH_RESTART_DELAY_MS / 1000}s...`);
      setTimeout(() => {
        if (!this.stopping && !this.restarting) {
          this.spawnServer();
        }
      }, CRASH_RESTART_DELAY_MS);
    });
  }

  async stopServer() {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }

      setTimeout(() => {
        if (settled) return;
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done());
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          done();
        }
      }, STOP_TIMEOUT_MS);
    });

    this.child = null;
  }

  async pollUpdate() {
    if (this.updating || this.stopping) return;
    this.updating = true;
    try {
      const result = await checkAndApplyGitUpdate();
      if (!result.updated) return;

      appendLog(`Nova versao detectada (${result.oldHead.slice(0, 7)} -> ${result.newHead.slice(0, 7)}). Reiniciando sincronizador...`);
      this.restarting = true;
      await this.stopServer();

      if (result.selfChanged) {
        appendLog('Supervisor atualizado; iniciando nova instancia do edge-runner...');
        const nextRunner = spawn(process.execPath, ['src/edge-runner.js'], {
          cwd: ROOT_DIR,
          stdio: 'inherit',
          detached: true,
          env: process.env
        });
        nextRunner.unref();
        await this.shutdown(0);
        return;
      }

      this.restarting = false;
      this.spawnServer();
    } catch (err) {
      // Falha de rede temporaria ou branch divergente nao deve derrubar o servidor atual
      appendLog(`Verificacao de atualizacao ignorada: ${err.message}`);
      this.restarting = false;
    } finally {
      this.updating = false;
    }
  }

  async shutdown(exitCode = 0) {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.stopServer();
    process.exit(exitCode);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const runner = new EdgeRunner();
  process.on('SIGINT', () => runner.shutdown(0));
  process.on('SIGTERM', () => runner.shutdown(0));
  runner.start();
}
