import type { CpuSnapshot } from './types.js';
import { readCpuSnapshot, calculateCpuPercent } from './utils.js';

export function sampleCpuPercent(previousSnapshot: CpuSnapshot | undefined): {
  cpuPercent: number;
  snapshot: CpuSnapshot;
} {
  const snapshot = readCpuSnapshot();
  const cpuPercent = previousSnapshot ? calculateCpuPercent(previousSnapshot, snapshot) : 0;
  return { cpuPercent, snapshot };
}
