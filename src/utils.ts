import * as os from 'node:os';
import { FIGURE_SPACE } from './constants.js';
import type { CpuSnapshot, CpuProcess, DiskSample } from './types.js';

const CPU_TREND_BLOCKS = [
  '⣀',
  '⣄',
  '⣤',
  '⣦',
  '⣶',
  '⣷',
  '⣿'
];
export function readCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce<CpuSnapshot>(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0);

      return {
        idle: snapshot.idle + cpu.times.idle,
        total: snapshot.total + total,
      };
    },
    { idle: 0, total: 0 },
  );
}

export function calculateCpuPercent(previous: CpuSnapshot, current: CpuSnapshot): number {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0) {
    return 0;
  }

  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function calculateMemoryPercent(usedBytes: number, totalBytes: number): number {
  return totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value)).toString().padStart(2, FIGURE_SPACE)}%`;
}

export function formatPrecisePercent(value: number): string {
  return `${clampPercent(value).toFixed(1)}%`;
}

export function formatStatusBarPrecisePercent(value: number): string {
  return `${clampPercent(value).toFixed(1).padStart(4, FIGURE_SPACE)}%`;
}

export function formatCpuTrendGraph(samples: number[], length: number): string {
  const normalizedLength = Math.max(0, Math.round(length));
  const visibleSamples = samples.slice(-length);
  const paddedSamples = [
    ...Array.from({ length: Math.max(0, normalizedLength - visibleSamples.length) }, () => 0),
    ...visibleSamples,
  ].slice(-normalizedLength);

  return paddedSamples.map((sample) => {
    const blockIndex = Math.round((clampPercent(sample) / 100) * (CPU_TREND_BLOCKS.length - 1));
    return CPU_TREND_BLOCKS[blockIndex];
  }).join('');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${formatGigabytes(bytes)}GB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  }

  return `${Math.max(0, bytes).toFixed(0)}B`;
}

export function formatTransferRate(bytesPerSecond: number): string {
  const units = ['K', 'M', 'G'] as const;
  let unitIndex = 0;
  let normalizedValue = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
    ? bytesPerSecond / 1024
    : 0;

  while (unitIndex < units.length - 1 && normalizedValue >= 999.5) {
    normalizedValue /= 1024;
    unitIndex += 1;
  }

  let valueText: string;
  if (normalizedValue < 0.05) {
    valueText = '0';
  } else if (normalizedValue >= 100) {
    valueText = Math.round(normalizedValue).toString();
  } else {
    valueText = normalizedValue.toFixed(1);
  }

  return `${valueText.padStart(4, FIGURE_SPACE)}${units[unitIndex]}/s`;
}

export function formatStorageUsage(usedBytes: number, totalBytes: number): string {
  return `${formatGigabytes(usedBytes)}GB / ${formatGigabytes(totalBytes)}GB`;
}

export function formatCompactStorageUsage(usedBytes: number, totalBytes: number): string {
  return `${formatGigabytes(usedBytes)}/${formatGigabytes(totalBytes)}G`;
}

export function formatDiskUsage(disk: DiskSample): string {
  return `${formatDiskLabel(disk.diskPath)} ${formatPercent(disk.diskPercent)}`;
}

export function formatDiskLabel(diskPath: string): string {
  if (/^[A-Za-z]:/.test(diskPath)) {
    return diskPath.slice(0, 2).toUpperCase();
  }

  return diskPath || '/';
}

export function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function formatProcessName(name: string): string {
  const normalizedName = name.trim().replace(/\s+/g, ' ');
  const maxLength = 90;

  if (normalizedName.length <= maxLength) {
    return normalizedName;
  }

  return `${normalizedName.slice(0, maxLength - 1)}...`;
}

export function formatProcessCpuPercent(value: number): string {
  return `${clampPercent(value).toFixed(1)}%`;
}

export function normalizeTopProcessCpuPercents(processes: CpuProcess[], totalCpuPercent: number): CpuProcess[] {
  const processTotal = processes.reduce((total, process) => total + Math.max(0, process.cpuPercent), 0);

  if (processTotal <= 0 || totalCpuPercent <= 0) {
    return processes.map((process) => ({ ...process, cpuPercent: 0 }));
  }

  return processes.map((process) => ({
    ...process,
    cpuPercent: (Math.max(0, process.cpuPercent) / processTotal) * clampPercent(totalCpuPercent),
  }));
}
