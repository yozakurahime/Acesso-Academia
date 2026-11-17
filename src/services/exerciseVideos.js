import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_EXERCISE_VIDEO = '30mb';
const VIDEO_TYPES = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function detectVideo(body) {
  if (!Buffer.isBuffer(body) || body.length < 16) return null;
  if (body.toString('ascii', 4, 8) === 'ftyp') {
    const brand = body.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'mov';
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) return 'mp4';
  }
  if (body.readUInt32BE(0) === 0x1a45dfa3 && body.subarray(0, 1024).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) {
    return 'webm';
  }
  return null;
}

export class ExerciseVideos {
  constructor(store, directory) {
    this.store = store;
    this.directory = directory;
  }

  async save(key, body) {
    if (!this.store.get('SELECT 1 FROM exercise_catalog WHERE key = ?', [key])) throw httpError(404, 'Exercício não encontrado.');
    const format = detectVideo(body);
    if (!format) throw httpError(415, 'Envie um vídeo MP4, WebM ou MOV. Para maior compatibilidade, prefira MP4 (H.264).');
    const filename = `${randomUUID()}.${format}`;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(path.join(this.directory, filename), body, { flag: 'wx', flush: true });
      const previous = this.store.get('SELECT video_file FROM exercise_catalog WHERE key = ?', [key]).video_file;
      this.store.run('UPDATE exercise_catalog SET video_file = ? WHERE key = ?', [filename, key]);
      this.cleanup(previous);
      return { has_video: true };
    } catch (err) {
      this.cleanup(filename);
      throw httpError(500, 'Falha ao salvar o vídeo: ' + err.message);
    }
  }

  remove(key) {
    const exercise = this.store.get('SELECT video_file FROM exercise_catalog WHERE key = ?', [key]);
    if (!exercise) throw httpError(404, 'Exercício não encontrado.');
    this.store.run('UPDATE exercise_catalog SET video_file = NULL WHERE key = ?', [key]);
    this.cleanup(exercise.video_file);
    return { has_video: false };
  }

  cleanup(filename) {
    if (filename) fs.unlink(path.join(this.directory, filename)).catch((err) => {
      if (err.code !== 'ENOENT') console.error('Falha ao limpar vídeo de exercício:', err);
    });
  }

  send(res, filename) {
    if (!filename) throw httpError(404, 'Demonstração indisponível.');
    res.sendFile(filename, {
      root: this.directory,
      headers: {
        'Content-Type': VIDEO_TYPES[path.extname(filename).slice(1)],
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }, (err) => {
      if (!err) return;
      if (res.headersSent) res.destroy();
      else res.sendStatus(err.statusCode || 500);
    });
  }
}
