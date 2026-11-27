import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const allFiles = fs
  .readdirSync('tests')
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('tests', name));

const perfFile = path.join('tests', 'apiPerformanceFlows.test.js');
const regularFiles = allFiles.filter((file) => file !== perfFile);

for (const batch of [regularFiles, allFiles.includes(perfFile) ? [perfFile] : []]) {
  if (!batch.length) continue;
  const result = spawnSync(process.execPath, ['--test', ...batch], {
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}
