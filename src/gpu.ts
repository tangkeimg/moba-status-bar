import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import type { GpuAggregateSample, GpuDeviceSample } from './types.js';
import { calculateMemoryPercent, clampPercent } from './utils.js';

const execFileAsync = promisify(execFile);
const GPU_COMMAND_TIMEOUT_MS = 5000;
const GPU_MEMORY_REFRESH_MS = 5000;
const WINDOWS_GPU_UTIL_REFRESH_MS = 2000;
const WINDOWS_GPU_MEMORY_REFRESH_MS = 10000;

type GpuBackend = 'windows-counters' | 'linux-nvidia-smi' | 'linux-rocm-smi' | 'none';

type GpuCounterSampleRow = {
  InstanceName?: string;
  CookedValue?: number;
};

type GpuCounterSnapshot = {
  Utilization?: GpuCounterSampleRow[] | GpuCounterSampleRow;
  Memory?: GpuCounterSampleRow[] | GpuCounterSampleRow;
};

type WindowsGpuMetadata = {
  name?: string;
  memoryTotalBytes?: number;
};

export interface GpuSampler {
  readSample(): Promise<GpuAggregateSample | undefined>;
  reset(): void;
}

export function createGpuSampler(): GpuSampler {
  let backendPromise: Promise<GpuBackend> | undefined;
  let cachedMemoryByDeviceId = new Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>();
  let nextMemoryRefreshAt = 0;
  let cachedSample: GpuAggregateSample | undefined;
  let nextWindowsUtilRefreshAt = 0;
  let nextWindowsMemoryRefreshAt = 0;
  let windowsMetadataPromise: Promise<Map<string, WindowsGpuMetadata>> | undefined;

  return {
    async readSample() {
      const backend = await (backendPromise ??= detectGpuBackend());

      if (backend === 'none') {
        return undefined;
      }

      try {
        switch (backend) {
          case 'windows-counters':
            windowsMetadataPromise ??= readWindowsGpuMetadata();
            cachedSample = await readWindowsGpuSample(
              cachedSample,
              nextWindowsUtilRefreshAt,
              nextWindowsMemoryRefreshAt,
              windowsMetadataPromise,
            ) ?? cachedSample;
            nextWindowsUtilRefreshAt = Date.now() + WINDOWS_GPU_UTIL_REFRESH_MS;
            nextWindowsMemoryRefreshAt = Date.now() + WINDOWS_GPU_MEMORY_REFRESH_MS;
            return cachedSample;
          case 'linux-nvidia-smi':
            cachedSample = await readNvidiaSmiGpuSample() ?? cachedSample;
            return cachedSample;
          case 'linux-rocm-smi':
            return await readRocmSmiGpuSample(cachedMemoryByDeviceId, nextMemoryRefreshAt).then((result) => {
              if (result) {
                cachedMemoryByDeviceId = result.memoryCache;
                nextMemoryRefreshAt = result.nextMemoryRefreshAt;
                cachedSample = result.sample ?? cachedSample;
                return cachedSample;
              }

              return cachedSample;
            });
          default:
            return cachedSample;
        }
      } catch {
        return cachedSample;
      }
    },

    reset() {
      cachedMemoryByDeviceId = new Map();
      cachedSample = undefined;
      nextMemoryRefreshAt = 0;
      nextWindowsUtilRefreshAt = 0;
      nextWindowsMemoryRefreshAt = 0;
      windowsMetadataPromise = undefined;
    },
  };
}

async function detectGpuBackend(): Promise<GpuBackend> {
  switch (os.platform()) {
    case 'win32':
      return 'windows-counters';
    case 'linux':
      if (await commandExists('nvidia-smi')) {
        return 'linux-nvidia-smi';
      }

      if (await commandExists('rocm-smi')) {
        return 'linux-rocm-smi';
      }

      return 'none';
    default:
      return 'none';
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: GPU_COMMAND_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function readWindowsGpuSample(
  previousSample: GpuAggregateSample | undefined,
  nextUtilRefreshAt: number,
  nextMemoryRefreshAt: number,
  windowsMetadataPromise: Promise<Map<string, WindowsGpuMetadata>>,
): Promise<GpuAggregateSample | undefined> {
  const now = Date.now();
  const [utilizationRows, memoryRows, metadataByDeviceId] = await Promise.all([
    now >= nextUtilRefreshAt ? readWindowsCounterRows('Utilization') : Promise.resolve<GpuCounterSampleRow[]>([]),
    now >= nextMemoryRefreshAt ? readWindowsCounterRows('Memory') : Promise.resolve<GpuCounterSampleRow[]>([]),
    windowsMetadataPromise,
  ]);
  const deviceMap = new Map<string, GpuDeviceSample>(
    previousSample?.devices.map((device) => [device.id, { ...device }]) ?? [],
  );

  if (utilizationRows.length === 0 && memoryRows.length === 0 && deviceMap.size > 0) {
    return previousSample;
  }

  mergeWindowsCounterRows(deviceMap, utilizationRows, 'utilization');
  mergeWindowsCounterRows(deviceMap, memoryRows, 'memory');

  const sortedDeviceIds = [...deviceMap.keys()].sort();

  for (const [index, deviceId] of sortedDeviceIds.entries()) {
    const current = deviceMap.get(deviceId);

    if (!current) {
      continue;
    }

    const metadata = metadataByDeviceId.get(deviceId);
    current.index = index;
    current.name = metadata?.name ?? `GPU ${index}`;

    if (metadata?.memoryTotalBytes !== undefined) {
      current.memoryTotalBytes = metadata.memoryTotalBytes;
    }

    current.memoryPercent =
      current.memoryUsedBytes !== undefined && current.memoryTotalBytes !== undefined
        ? calculateMemoryPercent(current.memoryUsedBytes, current.memoryTotalBytes)
        : undefined;
  }

  return createAggregateGpuSample([...deviceMap.values()]);
}

async function readNvidiaSmiGpuSample(): Promise<GpuAggregateSample | undefined> {
  const { stdout } = await execFileAsync(
    'nvidia-smi',
    ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { timeout: GPU_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const devices: GpuDeviceSample[] = [];

  for (const line of lines) {
    const segments = line.split(',').map((segment) => segment.trim());

    if (segments.length < 5) {
      continue;
    }

    const index = Number(segments[0]);
    const name = segments.slice(1, segments.length - 3).join(', ') || `GPU ${devices.length}`;
    const utilizationPercent = parseNumericValue(segments[segments.length - 3]);
    const memoryUsedBytes = parseNumericValue(segments[segments.length - 2], 1024 ** 2);
    const memoryTotalBytes = parseNumericValue(segments[segments.length - 1], 1024 ** 2);

    devices.push({
      id: `nvidia-${Number.isFinite(index) ? index : devices.length}`,
      index: Number.isFinite(index) ? index : devices.length,
      name,
      utilizationPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent:
        memoryUsedBytes !== undefined && memoryTotalBytes !== undefined
          ? calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes)
          : undefined,
    });
  }

  return createAggregateGpuSample(devices);
}

async function readRocmSmiGpuSample(
  cachedMemoryByDeviceId: Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>,
  nextMemoryRefreshAt: number,
): Promise<{
  sample: GpuAggregateSample | undefined;
  memoryCache: Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>;
  nextMemoryRefreshAt: number;
}> {
  const { stdout } = await execFileAsync(
    'rocm-smi',
    ['--showproductname', '--showuse', '--showmeminfo', 'vram', '--json'],
    { timeout: GPU_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const raw = stdout.trim();

  if (!raw) {
    return {
      sample: undefined,
      memoryCache: cachedMemoryByDeviceId,
      nextMemoryRefreshAt,
    };
  }

  const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  const devices: GpuDeviceSample[] = [];
  const nextMemoryCache = Date.now() >= nextMemoryRefreshAt ? new Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>() : cachedMemoryByDeviceId;

  for (const [deviceKey, values] of Object.entries(parsed)) {
    const indexMatch = deviceKey.match(/\d+/);
    const index = indexMatch ? Number(indexMatch[0]) : devices.length;
    const id = `rocm-${index}`;
    const name = values['Card series'] ?? values['Card SKU'] ?? `GPU ${index}`;
    const utilizationPercent = parsePercentField(values, ['GPU use (%)', 'GPU use']);

    let memoryUsedBytes = cachedMemoryByDeviceId.get(id)?.memoryUsedBytes;
    let memoryTotalBytes = cachedMemoryByDeviceId.get(id)?.memoryTotalBytes;

    if (Date.now() >= nextMemoryRefreshAt) {
      memoryUsedBytes = parseByteField(values, ['VRAM Total Used Memory (B)', 'VRAM Total Used Memory (bytes)']);
      memoryTotalBytes = parseByteField(values, ['VRAM Total Memory (B)', 'VRAM Total Memory (bytes)']);

      nextMemoryCache.set(id, {
        memoryUsedBytes,
        memoryTotalBytes,
        memoryPercent:
          memoryUsedBytes !== undefined && memoryTotalBytes !== undefined
            ? calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes)
            : undefined,
      });
    }

    devices.push({
      id,
      index,
      name,
      utilizationPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent:
        memoryUsedBytes !== undefined && memoryTotalBytes !== undefined
          ? calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes)
          : undefined,
    });
  }

  return {
    sample: createAggregateGpuSample(devices),
    memoryCache: nextMemoryCache,
    nextMemoryRefreshAt: Date.now() + GPU_MEMORY_REFRESH_MS,
  };
}

function extractWindowsGpuDeviceId(instanceName: string): string | undefined {
  const match = instanceName.match(/luid_[^_]+_[^_]+_phys_\d+/);
  return match?.[0];
}

async function readWindowsCounterRows(kind: keyof GpuCounterSnapshot): Promise<GpuCounterSampleRow[]> {
  const counterPath =
    kind === 'Utilization'
      ? '\\GPU Engine(*)\\Utilization Percentage'
      : '\\GPU Adapter Memory(*)\\Dedicated Usage';
  const script = [
    `$samples = (Get-Counter '${counterPath}').CounterSamples | ForEach-Object {`,
    '  [PSCustomObject]@{',
    '    InstanceName = $_.InstanceName',
    '    CookedValue = [double]$_.CookedValue',
    '  }',
    '}',
    '$samples | ConvertTo-Json -Compress -Depth 3',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: GPU_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const raw = stdout.trim();

  if (!raw) {
    return [];
  }

  return toArray(JSON.parse(raw) as GpuCounterSampleRow[] | GpuCounterSampleRow);
}

function mergeWindowsCounterRows(
  deviceMap: Map<string, GpuDeviceSample>,
  rows: GpuCounterSampleRow[],
  kind: 'utilization' | 'memory',
): void {
  const touchedDeviceIds = new Set<string>();

  for (const row of rows) {
    const instanceName = typeof row.InstanceName === 'string' ? row.InstanceName : '';
    const deviceId = extractWindowsGpuDeviceId(instanceName);

    if (!deviceId) {
      continue;
    }

    const current = deviceMap.get(deviceId) ?? {
      id: deviceId,
      index: deviceMap.size,
      name: `GPU ${deviceMap.size}`,
    };

    if (kind === 'utilization') {
      const utilizationPercent = clampPercent(typeof row.CookedValue === 'number' ? row.CookedValue : 0);
      current.utilizationPercent = Math.max(current.utilizationPercent ?? 0, utilizationPercent);
      touchedDeviceIds.add(deviceId);
    } else {
      current.memoryUsedBytes = Math.max(current.memoryUsedBytes ?? 0, typeof row.CookedValue === 'number' ? row.CookedValue : 0);
    }

    deviceMap.set(deviceId, current);
  }

  if (kind === 'utilization') {
    for (const [deviceId, current] of deviceMap.entries()) {
      if (!touchedDeviceIds.has(deviceId)) {
        current.utilizationPercent = 0;
        deviceMap.set(deviceId, current);
      }
    }
  }
}

async function readWindowsGpuMetadata(): Promise<Map<string, WindowsGpuMetadata>> {
  const script = [
    "$items = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Video\\*\\0000' -ErrorAction SilentlyContinue | ForEach-Object {",
    '  $memory = $null',
    "  foreach ($propertyName in @('HardwareInformation.qwMemorySize', 'HardwareInformation.MemorySize', 'HardwareInformation_qwMemorySize', 'HardwareInformation_MemorySize')) {",
    '    try {',
    '      $candidate = $_.PSObject.Properties[$propertyName]',
    '      if ($candidate -and $candidate.Value) {',
    '        $memory = [double]$candidate.Value',
    '        break',
    '      }',
    '    } catch { }',
    '  }',
    '  [PSCustomObject]@{',
    '    Name = [string]$_.DriverDesc',
    '    MemoryTotalBytes = $memory',
    '  }',
    "} | Where-Object { $_.Name }",
    '$items | ConvertTo-Json -Compress -Depth 3',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: GPU_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const raw = stdout.trim();

  if (!raw) {
    return new Map();
  }

  const metadataRows = toArray(JSON.parse(raw) as Array<{ Name?: string; MemoryTotalBytes?: number }> | { Name?: string; MemoryTotalBytes?: number });
  const metadataEntries = metadataRows
    .map((row) => ({
      name: typeof row.Name === 'string' ? row.Name.trim() : '',
      memoryTotalBytes: typeof row.MemoryTotalBytes === 'number' && Number.isFinite(row.MemoryTotalBytes) ? row.MemoryTotalBytes : undefined,
    }))
    .filter((row) => row.name);
  const utilizationRows = await readWindowsCounterRows('Utilization');
  const sortedDeviceIds = [...new Set(utilizationRows
    .map((row) => typeof row.InstanceName === 'string' ? extractWindowsGpuDeviceId(row.InstanceName) : undefined)
    .filter((deviceId): deviceId is string => Boolean(deviceId)))]
    .sort();
  const metadataByDeviceId = new Map<string, WindowsGpuMetadata>();

  for (const [index, deviceId] of sortedDeviceIds.entries()) {
    const metadata = metadataEntries[index];

    if (metadata) {
      metadataByDeviceId.set(deviceId, metadata);
    }
  }

  return metadataByDeviceId;
}

function toArray<T>(value: T[] | T | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function createAggregateGpuSample(devices: GpuDeviceSample[]): GpuAggregateSample | undefined {
  const normalizedDevices = devices
    .map((device, index) => ({
      ...device,
      index,
      utilizationPercent: device.utilizationPercent !== undefined ? clampPercent(device.utilizationPercent) : undefined,
      memoryPercent:
        device.memoryUsedBytes !== undefined && device.memoryTotalBytes !== undefined
          ? calculateMemoryPercent(device.memoryUsedBytes, device.memoryTotalBytes)
          : device.memoryPercent,
    }))
    .sort((left, right) => {
      const rightUtilization = right.utilizationPercent ?? -1;
      const leftUtilization = left.utilizationPercent ?? -1;

      if (rightUtilization !== leftUtilization) {
        return rightUtilization - leftUtilization;
      }

      return left.index - right.index;
    });

  if (normalizedDevices.length === 0) {
    return undefined;
  }

  const utilizationDevices = normalizedDevices.filter((device) => device.utilizationPercent !== undefined);
  const aggregateUtilizationPercent =
    utilizationDevices.length > 0
      ? utilizationDevices.reduce((sum, device) => sum + (device.utilizationPercent ?? 0), 0) / utilizationDevices.length
      : 0;
  const memoryDevicesWithUsed = normalizedDevices.filter((device) => device.memoryUsedBytes !== undefined);
  const aggregateMemoryUsedBytes = memoryDevicesWithUsed.reduce((sum, device) => sum + (device.memoryUsedBytes ?? 0), 0);
  const devicesWithMemoryTotals = normalizedDevices.filter(
    (device) => device.memoryTotalBytes !== undefined && device.memoryTotalBytes > 0,
  );
  const hasCompleteAggregateMemoryTotal =
    memoryDevicesWithUsed.length > 0 && devicesWithMemoryTotals.length === normalizedDevices.length;
  const aggregateMemoryTotalBytes = hasCompleteAggregateMemoryTotal
    ? devicesWithMemoryTotals.reduce((sum, device) => sum + (device.memoryTotalBytes ?? 0), 0)
    : undefined;

  return {
    devices: normalizedDevices,
    aggregateUtilizationPercent,
    aggregateMemoryUsedBytes: memoryDevicesWithUsed.length > 0 ? aggregateMemoryUsedBytes : undefined,
    aggregateMemoryTotalBytes,
    aggregateMemoryPercent:
      aggregateMemoryUsedBytes > 0 && aggregateMemoryTotalBytes !== undefined && aggregateMemoryTotalBytes > 0
        ? calculateMemoryPercent(aggregateMemoryUsedBytes, aggregateMemoryTotalBytes)
        : undefined,
    hasAnyMemoryData: normalizedDevices.some((device) => device.memoryUsedBytes !== undefined || device.memoryTotalBytes !== undefined),
  };
}

function parseNumericValue(value: string, multiplier = 1): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * multiplier : undefined;
}

function parsePercentField(source: Record<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];

    if (!value) {
      continue;
    }

    const match = value.match(/-?\d+(\.\d+)?/);

    if (match) {
      return clampPercent(Number(match[0]));
    }
  }

  return undefined;
}

function parseByteField(source: Record<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];

    if (!value) {
      continue;
    }

    const match = value.match(/\d+/);

    if (match) {
      return Number(match[0]);
    }
  }

  return undefined;
}
