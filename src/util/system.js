// Device stats: RAM, battery (Termux:API), process memory. Each probe fails soft.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

export function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0);
    return { totalMb: kb('MemTotal') / 1024, availableMb: kb('MemAvailable') / 1024 };
  } catch {
    // macOS / no procfs
    return { totalMb: os.totalmem() / 2 ** 20, availableMb: os.freemem() / 2 ** 20 };
  }
}

/** Battery via `termux-battery-status` (needs the Termux:API app + `pkg install termux-api`). */
export function batteryStatus(timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile('termux-battery-status', { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        resolve({ percent: j.percentage, tempC: j.temperature, status: j.status, plugged: j.plugged });
      } catch {
        resolve(null);
      }
    });
  });
}

export const processRssMb = () => process.memoryUsage().rss / 2 ** 20;
