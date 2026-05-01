import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import { promisify } from 'node:util';
import type { NetworkSample } from './types.js';

const execFileAsync = promisify(execFile);
const NETWORK_COMMAND_TIMEOUT_MS = 1500;
const NETWORK_REFRESH_FAST_MS = 1500;
const NETWORK_REFRESH_NORMAL_MS = 3000;
const NETWORK_REFRESH_SLOW_MS = 6000;
const NETWORK_REFRESH_MAX_MS = 12000;

type NetworkBackend = 'windows-netadapter' | 'linux-procfs' | 'none';

type NetworkCounterRow = {
  interfaceName: string;
  interfaceDescription?: string;
  downloadBytes: number;
  uploadBytes: number;
};

type NetworkCounterSnapshot = {
  capturedAt: number;
  rows: NetworkCounterRow[];
};

type WindowsNetworkStatsRow = {
  Name?: unknown;
  InterfaceDescription?: unknown;
  ReceivedBytes?: unknown;
  SentBytes?: unknown;
};

export interface NetworkSampler {
  readSample(): Promise<NetworkSample | undefined>;
  reset(): void;
}

export function createNetworkSampler(): NetworkSampler {
  let backendPromise: Promise<NetworkBackend> | undefined;
  let previousSnapshot: NetworkCounterSnapshot | undefined;
  let cachedSample: NetworkSample | undefined;
  let nextRefreshAt = 0;

  return {
    async readSample() {
      if (cachedSample && Date.now() < nextRefreshAt) {
        return cachedSample;
      }

      try {
        const backend = await (backendPromise ??= detectNetworkBackend());

        if (backend === 'none') {
          return undefined;
        }

        const hadPreviousSnapshot = previousSnapshot !== undefined;
        const snapshot = await readCounterSnapshot(backend);

        if (snapshot.rows.length === 0) {
          nextRefreshAt = Date.now() + NETWORK_REFRESH_SLOW_MS;
          return cachedSample;
        }

        cachedSample = createNetworkSample(previousSnapshot, snapshot, cachedSample);
        previousSnapshot = snapshot;
        nextRefreshAt = Date.now() + (hadPreviousSnapshot ? calculateNextRefreshInterval(cachedSample) : NETWORK_REFRESH_FAST_MS);
        return cachedSample;
      } catch {
        nextRefreshAt = Date.now() + NETWORK_REFRESH_NORMAL_MS;
        return cachedSample;
      }
    },

    reset() {
      backendPromise = undefined;
      previousSnapshot = undefined;
      cachedSample = undefined;
      nextRefreshAt = 0;
    },
  };
}

async function detectNetworkBackend(): Promise<NetworkBackend> {
  switch (os.platform()) {
    case 'win32':
      return 'windows-netadapter';
    case 'linux':
      return 'linux-procfs';
    default:
      return 'none';
  }
}

async function readCounterSnapshot(backend: NetworkBackend): Promise<NetworkCounterSnapshot> {
  switch (backend) {
    case 'windows-netadapter':
      return readWindowsCounterSnapshot();
    case 'linux-procfs':
      return readLinuxCounterSnapshot();
    default:
      return { capturedAt: Date.now(), rows: [] };
  }
}

async function readWindowsCounterSnapshot(): Promise<NetworkCounterSnapshot> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + [
        'Get-NetAdapterStatistics',
        "Where-Object { $_.Name -and $_.ReceivedBytes -ne $null -and $_.SentBytes -ne $null }",
        'Select-Object Name,InterfaceDescription,ReceivedBytes,SentBytes',
        'ConvertTo-Json -Compress',
      ].join(' | '),
    ],
    { timeout: NETWORK_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
  );

  const rows = parseJsonRows<WindowsNetworkStatsRow>(stdout)
    .map((entry) => {
      const interfaceName = typeof entry.Name === 'string' ? entry.Name.trim() : '';
      const interfaceDescription = typeof entry.InterfaceDescription === 'string' ? entry.InterfaceDescription.trim() : undefined;
      const downloadBytes = normalizeCounterValue(entry.ReceivedBytes);
      const uploadBytes = normalizeCounterValue(entry.SentBytes);

      if (!interfaceName || !Number.isFinite(downloadBytes) || !Number.isFinite(uploadBytes) || isIgnoredNetworkInterface(interfaceName)) {
        return undefined;
      }

      const result: NetworkCounterRow = {
        interfaceName,
        downloadBytes,
        uploadBytes,
      };

      if (interfaceDescription) {
        result.interfaceDescription = interfaceDescription;
      }

      return result;
    })
    .filter((row): row is NetworkCounterRow => row !== undefined);

  return {
    capturedAt: Date.now(),
    rows,
  };
}

async function readLinuxCounterSnapshot(): Promise<NetworkCounterSnapshot> {
  const contents = await readFile('/proc/net/dev', 'utf8');
  const rows = contents
    .split(/\r?\n/)
    .slice(2)
    .map((line) => parseLinuxCounterRow(line))
    .filter((row): row is NetworkCounterRow => row !== undefined);

  return {
    capturedAt: Date.now(),
    rows,
  };
}

function parseLinuxCounterRow(line: string): NetworkCounterRow | undefined {
  const trimmedLine = line.trim();

  if (!trimmedLine) {
    return undefined;
  }

  const separatorIndex = trimmedLine.indexOf(':');

  if (separatorIndex < 0) {
    return undefined;
  }

  const interfaceName = trimmedLine.slice(0, separatorIndex).trim();
  const values = trimmedLine.slice(separatorIndex + 1).trim().split(/\s+/);

  if (values.length < 16 || isIgnoredNetworkInterface(interfaceName)) {
    return undefined;
  }

  const downloadBytes = Number(values[0]);
  const uploadBytes = Number(values[8]);

  if (!Number.isFinite(downloadBytes) || !Number.isFinite(uploadBytes)) {
    return undefined;
  }

  return {
    interfaceName,
    downloadBytes,
    uploadBytes,
  };
}

function createNetworkSample(
  previousSnapshot: NetworkCounterSnapshot | undefined,
  currentSnapshot: NetworkCounterSnapshot,
  previousSample: NetworkSample | undefined,
): NetworkSample | undefined {
  const preferredInterfaceName = previousSample?.interfaceName;

  if (!previousSnapshot) {
    const row = selectPreferredCounterRow(currentSnapshot.rows, preferredInterfaceName);

    if (!row) {
      return undefined;
    }

    return {
      interfaceName: row.interfaceName,
      interfaceDescription: row.interfaceDescription,
      downloadBytesPerSecond: 0,
      uploadBytesPerSecond: 0,
    };
  }

  const elapsedSeconds = Math.max(0.5, (currentSnapshot.capturedAt - previousSnapshot.capturedAt) / 1000);
  const previousRowsByName = new Map(previousSnapshot.rows.map((row) => [row.interfaceName, row]));
  const samples = currentSnapshot.rows
    .map((row) => {
      const previousRow = previousRowsByName.get(row.interfaceName);

      if (!previousRow) {
        return undefined;
      }

      const sample: NetworkSample = {
        interfaceName: row.interfaceName,
        downloadBytesPerSecond: Math.max(0, row.downloadBytes - previousRow.downloadBytes) / elapsedSeconds,
        uploadBytesPerSecond: Math.max(0, row.uploadBytes - previousRow.uploadBytes) / elapsedSeconds,
      };

      if (row.interfaceDescription) {
        sample.interfaceDescription = row.interfaceDescription;
      }

      return sample;
    })
    .filter((sample): sample is NetworkSample => sample !== undefined);

  if (samples.length === 0) {
    const row = selectPreferredCounterRow(currentSnapshot.rows, preferredInterfaceName);

    if (!row) {
      return previousSample;
    }

    return {
      interfaceName: row.interfaceName,
      interfaceDescription: row.interfaceDescription,
      downloadBytesPerSecond: 0,
      uploadBytesPerSecond: 0,
    };
  }

  return selectPreferredSample(samples, preferredInterfaceName);
}

function selectPreferredCounterRow(
  rows: NetworkCounterRow[],
  preferredInterfaceName: string | undefined,
): NetworkCounterRow | undefined {
  if (preferredInterfaceName) {
    const preferredRow = rows.find((row) => row.interfaceName === preferredInterfaceName);

    if (preferredRow) {
      return preferredRow;
    }
  }

  return rows[0];
}

function selectPreferredSample(samples: NetworkSample[], preferredInterfaceName: string | undefined): NetworkSample | undefined {
  if (samples.length === 0) {
    return undefined;
  }

  let bestSample = preferredInterfaceName
    ? samples.find((sample) => sample.interfaceName === preferredInterfaceName) ?? samples[0]
    : samples[0];

  for (const sample of samples) {
    if (isBetterSample(sample, bestSample, preferredInterfaceName)) {
      bestSample = sample;
    }
  }

  return bestSample;
}

function isBetterSample(
  candidate: NetworkSample,
  currentBest: NetworkSample,
  preferredInterfaceName: string | undefined,
): boolean {
  const candidateDownload = candidate.downloadBytesPerSecond;
  const currentBestDownload = currentBest.downloadBytesPerSecond;

  if (candidateDownload > currentBestDownload + 1) {
    return true;
  }

  if (currentBestDownload > candidateDownload + 1) {
    return false;
  }

  const candidateTotal = candidate.downloadBytesPerSecond + candidate.uploadBytesPerSecond;
  const currentBestTotal = currentBest.downloadBytesPerSecond + currentBest.uploadBytesPerSecond;

  if (candidateTotal > currentBestTotal + 1) {
    return true;
  }

  if (currentBestTotal > candidateTotal + 1) {
    return false;
  }

  return candidate.interfaceName === preferredInterfaceName && currentBest.interfaceName !== preferredInterfaceName;
}

function calculateNextRefreshInterval(sample: NetworkSample | undefined): number {
  if (!sample) {
    return NETWORK_REFRESH_SLOW_MS;
  }

  const totalBytesPerSecond = sample.downloadBytesPerSecond + sample.uploadBytesPerSecond;

  if (totalBytesPerSecond >= 1024 ** 2) {
    return NETWORK_REFRESH_FAST_MS;
  }

  if (totalBytesPerSecond >= 128 * 1024) {
    return NETWORK_REFRESH_NORMAL_MS;
  }

  if (totalBytesPerSecond > 0) {
    return NETWORK_REFRESH_SLOW_MS;
  }

  return NETWORK_REFRESH_MAX_MS;
}

function parseJsonRows<T>(stdout: string): T[] {
  const trimmedStdout = stdout.trim();

  if (!trimmedStdout) {
    return [];
  }

  const parsed = JSON.parse(trimmedStdout) as T | T[] | null;

  if (!parsed) {
    return [];
  }

  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeCounterValue(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : Number.NaN;
  }

  return Number.NaN;
}

function isIgnoredNetworkInterface(interfaceName: string): boolean {
  const normalizedName = interfaceName.trim().toLowerCase();

  return normalizedName === 'lo'
    || normalizedName.includes('loopback')
    || normalizedName.startsWith('isatap')
    || normalizedName.startsWith('teredo')
    || normalizedName.includes('pseudo-interface');
}
