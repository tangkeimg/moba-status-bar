import checkDiskSpace from 'check-disk-space';
import {
  DISK_REFRESH_FAST_MS,
  DISK_REFRESH_NORMAL_MS,
  DISK_REFRESH_SLOW_MS,
  DISK_REFRESH_MAX_MS,
} from './constants.js';
import type { DiskSample } from './types.js';

export interface DiskSampler {
  readSample(): Promise<DiskSample | undefined>;
  reset(): void;
}

export function createDiskSampler(diskTargetPath: string): DiskSampler {
  let cachedDiskSample: DiskSample | undefined;
  let nextDiskRefreshAt = 0;

  return {
    async readSample() {
      if (cachedDiskSample && Date.now() < nextDiskRefreshAt) {
        return cachedDiskSample;
      }

      const previousDiskSample = cachedDiskSample;
      const nextDiskSample = await readDiskSample(diskTargetPath);

      if (!nextDiskSample) {
        nextDiskRefreshAt = Date.now() + DISK_REFRESH_NORMAL_MS;
        return cachedDiskSample;
      }

      cachedDiskSample = nextDiskSample;
      nextDiskRefreshAt = Date.now() + calculateNextDiskRefreshInterval(previousDiskSample, nextDiskSample);
      return cachedDiskSample;
    },

    reset() {
      cachedDiskSample = undefined;
      nextDiskRefreshAt = 0;
    },
  };
}

async function readDiskSample(diskTargetPath: string): Promise<DiskSample | undefined> {
  try {
    const diskSpace = await checkDiskSpace(diskTargetPath);
    const diskTotalBytes = diskSpace.size;
    const diskUsedBytes = diskSpace.size - diskSpace.free;
    const diskPercent = diskTotalBytes > 0 ? (diskUsedBytes / diskTotalBytes) * 100 : 0;

    return {
      diskPath: diskSpace.diskPath,
      diskPercent,
      diskUsedBytes,
      diskTotalBytes,
    };
  } catch {
    return undefined;
  }
}

function calculateNextDiskRefreshInterval(
  previousDiskSample: DiskSample | undefined,
  nextDiskSample: DiskSample,
): number {
  if (!previousDiskSample || previousDiskSample.diskPath !== nextDiskSample.diskPath) {
    return DISK_REFRESH_FAST_MS;
  }

  const usedBytesDelta = Math.abs(nextDiskSample.diskUsedBytes - previousDiskSample.diskUsedBytes);
  const totalBytes = Math.max(1, nextDiskSample.diskTotalBytes);
  const usedPercentDelta = (usedBytesDelta / totalBytes) * 100;

  if (usedPercentDelta >= 1 || usedBytesDelta >= 1024 ** 3) {
    return DISK_REFRESH_FAST_MS;
  }

  if (usedPercentDelta >= 0.1 || usedBytesDelta >= 100 * 1024 ** 2) {
    return DISK_REFRESH_NORMAL_MS;
  }

  if (usedPercentDelta >= 0.01 || usedBytesDelta >= 10 * 1024 ** 2) {
    return DISK_REFRESH_SLOW_MS;
  }

  return DISK_REFRESH_MAX_MS;
}
