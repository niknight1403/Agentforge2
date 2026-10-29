import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, now } from './db.mjs';

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;
let previousCpu = null;
let latest = null;
let timer = null;

db.exec(`CREATE TABLE IF NOT EXISTS resource_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at INTEGER NOT NULL,
  pressure TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  memory_pct REAL NOT NULL,
  gpu_memory_pct REAL,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_samples_time ON resource_samples(sampled_at);`);

let hotStreak = 0;

function cpuTimes() {
  const cores = os.cpus();
  const totals = cores.map((core) => {
    const times = core.times;
    return { total: Object.values(times).reduce((sum, value) => sum + value, 0), idle: times.idle };
  });
  if (!previousCpu || previousCpu.length !== totals.length) {
    previousCpu = totals;
    return { cores: totals.length, usagePct: 0 };
  }
  let totalDelta = 0, idleDelta = 0;
  for (let i = 0; i < totals.length; i++) {
    totalDelta += Math.max(0, totals[i].total - previousCpu[i].total);
    idleDelta += Math.max(0, totals[i].idle - previousCpu[i].idle);
  }
  previousCpu = totals;
  return { cores: totals.length, usagePct: totalDelta ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0 };
}

async function nvidiaSnapshot() {
  const { stdout } = await execFileAsync('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.total,memory.used', '--format=csv,noheader,nounits'
  ], { timeout: 1500, maxBuffer: 32 * 1024, windowsHide: true });
  const devices = stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 16).map((line) => {
    const cols = line.split(',').map((value) => value.trim());
    const totalMiB = Number(cols[2]), usedMiB = Number(cols[3]);
    if (cols.length < 4 || !Number.isFinite(totalMiB) || !Number.isFinite(usedMiB)) return null;
    return { name: cols[0].slice(0, 100), utilizationPct: Number(cols[1]) || 0, totalBytes: totalMiB * MiB, usedBytes: usedMiB * MiB };
  }).filter(Boolean);
  return devices.length ? { available: true, source: 'nvidia-smi', devices } : null;
}

function amdSnapshot() {
  const root = '/sys/class/drm';
  try {
    const devices = readdirSync(root).filter((name) => /^card\d+$/.test(name)).slice(0, 16).flatMap((name) => {
      const dir = join(root, name, 'device');
      try {
        const vendor = readFileSync(join(dir, 'vendor'), 'utf8').trim().toLowerCase();
        if (vendor !== '0x1002') return [];
        const usedBytes = Number(readFileSync(join(dir, 'mem_info_vram_used'), 'utf8').trim());
        const totalBytes = Number(readFileSync(join(dir, 'mem_info_vram_total'), 'utf8').trim());
        if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return [];
        return [{ name: `AMD GPU ${name}`, utilizationPct: null, totalBytes, usedBytes }];
      } catch { return []; }
    });
    return devices.length ? { available: true, source: 'linux-sysfs', devices } : null;
  } catch { return null; }
}

function modelFit(availableBytes) {
  if (availableBytes >= 64 * 1024 ** 3) return '70B Q4-Klasse möglich; Kontextgröße gegen VRAM prüfen';
  if (availableBytes >= 16 * 1024 ** 3) return '13B Q4-Klasse möglich; Kontextgröße gegen VRAM prüfen';
  if (availableBytes >= 8 * 1024 ** 3) return '7B Q4-Klasse möglich; Kontextgröße gegen VRAM prüfen';
  if (availableBytes >= 4 * 1024 ** 3) return '3B Q4-Klasse empfohlen';
  return 'Kompaktes Modell unter 3B oder kostenlose Cloud-Route verwenden';
}

export function resourceStatus() {
  if (latest) return latest;
  const total = os.totalmem(), free = os.freemem(), load = os.loadavg();
  const cpu = cpuTimes();
  const usagePct = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  return buildSnapshot({ cpu, total, free, load, gpu: null, processRss: process.memoryUsage().rss, sampledAt: now(), persist: false });
}

function buildSnapshot({ cpu, total, free, load, gpu, processRss, sampledAt, persist }) {
  const memoryPct = total ? Math.round(((total - free) / total) * 1000) / 10 : 0;
  const devices = gpu?.devices || [];
  const gpuTotal = devices.reduce((sum, item) => sum + item.totalBytes, 0);
  const gpuUsed = devices.reduce((sum, item) => sum + item.usedBytes, 0);
  const gpuPct = gpuTotal ? Math.round((gpuUsed / gpuTotal) * 1000) / 10 : null;
  const cpuPct = Number(cpu.usagePct) || 0;
  // Hysterese statt Sofort-Alarm: einzelne CPU-Spitzen (Build, Inferenz-Burst,
  // Modell-Download) sollen die Parallelitaet nicht auf 1 Slot zusammenziehen.
  // CRITICAL erst bei anhaltender Saettigung (2+ Messungen in Folge) oder
  // akutem Speicherdruck; die Verfügbarkeit der Slots bleibt erhalten.
  const loadPerCorePct = cpu.cores ? (load[0] || 0) / cpu.cores * 100 : 0;
  const hotSample = cpuPct >= 95 || loadPerCorePct >= 95;
  hotStreak = hotSample ? Math.min(hotStreak + 1, 9) : 0;
  const sustainedHot = hotStreak >= 2;
  const pressure = memoryPct >= 92 || sustainedHot || (gpuPct !== null && gpuPct >= 97) ? 'CRITICAL'
    : memoryPct >= 82 || cpuPct >= 90 || loadPerCorePct >= 80 || (gpuPct !== null && gpuPct >= 90) ? 'WARNING' : 'NORMAL';
  const availableBytes = Math.max(0, free);
  const base = cpu.cores >= 16 ? 12 : cpu.cores >= 8 ? 8 : cpu.cores >= 4 ? 6 : 2;
  const maxConcurrentTasks = pressure === 'CRITICAL' || availableBytes < 2 * 1024 ** 3 ? 1
    : pressure === 'WARNING' || availableBytes < 4 * 1024 ** 3 ? Math.min(2, base) : base;
  const snapshot = {
    sampledAt,
    pressure,
    cpu: { cores: cpu.cores, usagePct: cpuPct, load1: Number((load[0] || 0).toFixed(2)), loadPerCorePct: cpu.cores ? Math.round((load[0] / cpu.cores) * 1000) / 10 : 0 },
    memory: { totalBytes: total, availableBytes: free, usedBytes: Math.max(0, total - free), usedPct: memoryPct, processRssBytes: processRss },
    gpu: { available: devices.length > 0, source: gpu?.source || 'not-detected', devices, totalBytes: gpuTotal, usedBytes: gpuUsed, usedPct: gpuPct },
    recommendation: { maxConcurrentTasks, localModelFit: modelFit(availableBytes), reason: pressure === 'NORMAL' ? 'Ressourcen haben ausreichende Reserve.' : `Ressourcendruck ${pressure}: Parallelität vorsorglich begrenzt.` }
  };
  if (persist) {
    db.prepare('INSERT INTO resource_samples(sampled_at,pressure,cpu_pct,memory_pct,gpu_memory_pct,snapshot) VALUES(?,?,?,?,?,?)')
      .run(sampledAt, pressure, cpuPct, memoryPct, gpuPct, JSON.stringify(snapshot));
    db.prepare('DELETE FROM resource_samples WHERE sampled_at < ?').run(sampledAt - 7 * 24 * 60 * 60 * 1000);
  }
  return snapshot;
}

export async function sampleResources({ gpuProbe = nvidiaSnapshot, clock = now } = {}) {
  let gpu = null;
  try { gpu = await gpuProbe(); } catch { gpu = amdSnapshot(); }
  if (!gpu) gpu = amdSnapshot();
  const cpu = cpuTimes();
  const total = os.totalmem(), free = os.freemem(), load = os.loadavg();
  latest = buildSnapshot({ cpu, total, free, load, gpu, processRss: process.memoryUsage().rss, sampledAt: clock(), persist: true });
  return latest;
}

export function recommendedConcurrency() {
  return Math.max(1, Number(latest?.recommendation?.maxConcurrentTasks) || Math.min(3, Math.max(1, Math.floor(os.cpus().length / 2))));
}

export function resourceHistory(limit = 120) {
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 120));
  return db.prepare('SELECT sampled_at AS sampledAt, pressure, cpu_pct AS cpuPct, memory_pct AS memoryPct, gpu_memory_pct AS gpuMemoryPct, snapshot FROM resource_samples ORDER BY sampled_at DESC LIMIT ?')
    .all(bounded).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
}

export function startResourceAgent({ intervalMs = 15_000, onSample = () => {}, onError = () => {} } = {}) {
  if (timer) return () => clearInterval(timer);
  const run = async () => {
    try { const snapshot = await sampleResources(); onSample(snapshot); }
    catch (error) { onError(error); }
  };
  void run();
  timer = setInterval(run, Math.max(5_000, Number(intervalMs) || 15_000));
  timer.unref?.();
  return () => { clearInterval(timer); timer = null; };
}
