import * as os from 'node:os';
import { calculateMemoryPercent } from './utils.js';

export function sampleMemory(): {
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
} {
  const memoryTotalBytes = os.totalmem();
  const memoryUsedBytes = memoryTotalBytes - os.freemem();
  const memoryPercent = calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes);
  return { memoryPercent, memoryUsedBytes, memoryTotalBytes };
}
