import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import { promisify } from 'node:util';
import type { GpuAggregateSample, GpuDeviceCategory, GpuDeviceSample, GpuDisplayConfig, GpuSummaryMode, GpuSummarySample } from './types.js';
import { calculateMemoryPercent, clampPercent } from './utils.js';

const execFileAsync = promisify(execFile);
const GPU_COMMAND_TIMEOUT_MS = 5000;
const WINDOWS_GPU_COMMAND_TIMEOUT_MS = 10000;
const GPU_MEMORY_REFRESH_MS = 5000;
const ACTIVE_GPU_UTILIZATION_THRESHOLD_PERCENT = 3;
const ACTIVE_GPU_MEMORY_THRESHOLD_BYTES = 1024 ** 3;
const ACTIVE_GPU_MEMORY_THRESHOLD_PERCENT = 10;

type GpuBackend = 'windows-counters' | 'linux-nvidia-smi' | 'linux-rocm-smi' | 'linux-amdgpu-sysfs' | 'none';
type LinuxGpuBackend = Extract<GpuBackend, 'linux-nvidia-smi' | 'linux-rocm-smi' | 'linux-amdgpu-sysfs'>;

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
  isPhysical: boolean;
};

type LinuxSysfsGpuInfo = {
  cardName: string;
  cardPath: string;
  devicePath: string;
};

export interface GpuSampler {
  readSample(): Promise<GpuAggregateSample | undefined>;
  reset(): void;
}

export function createGpuSampler(displayConfig: GpuDisplayConfig): GpuSampler {
  let backendPromise: Promise<GpuBackend> | undefined;
  let cachedMemoryByDeviceId = new Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>();
  let nextMemoryRefreshAt = 0;
  let cachedSample: GpuAggregateSample | undefined;
  let windowsMetadataPromise: Promise<WindowsGpuMetadata[]> | undefined;
  const linuxBackendAvailability = new Map<LinuxGpuBackend, Promise<boolean>>();

  function isLinuxBackendAvailable(backend: LinuxGpuBackend): Promise<boolean> {
    const cachedAvailability = linuxBackendAvailability.get(backend);

    if (cachedAvailability) {
      return cachedAvailability;
    }

    const availabilityPromise = backend === 'linux-amdgpu-sysfs'
      ? hasAmdGpuSysfsSupport()
      : commandExists(backend === 'linux-nvidia-smi' ? 'nvidia-smi' : 'rocm-smi');
    linuxBackendAvailability.set(backend, availabilityPromise);
    return availabilityPromise;
  }

  async function readLinuxGpuSampleForBackend(backend: LinuxGpuBackend): Promise<GpuAggregateSample | undefined> {
    switch (backend) {
      case 'linux-nvidia-smi':
        return await readNvidiaSmiGpuSample(displayConfig);
      case 'linux-rocm-smi': {
        const result = await readRocmSmiGpuSample(cachedMemoryByDeviceId, nextMemoryRefreshAt, displayConfig);
        cachedMemoryByDeviceId = result.memoryCache;
        nextMemoryRefreshAt = result.nextMemoryRefreshAt;
        return result.sample;
      }
      case 'linux-amdgpu-sysfs':
        return await readAmdGpuSysfsSample(displayConfig);
    }
  }

  async function readLinuxGpuSample(preferredBackend: LinuxGpuBackend): Promise<GpuAggregateSample | undefined> {
    const fallbackBackends = preferredBackend === 'linux-nvidia-smi'
      ? ['linux-rocm-smi', 'linux-amdgpu-sysfs'] satisfies LinuxGpuBackend[]
      : preferredBackend === 'linux-rocm-smi'
        ? ['linux-amdgpu-sysfs', 'linux-nvidia-smi'] satisfies LinuxGpuBackend[]
        : ['linux-rocm-smi', 'linux-nvidia-smi'] satisfies LinuxGpuBackend[];

    for (const backend of [preferredBackend, ...fallbackBackends]) {
      if (backend !== preferredBackend && !(await isLinuxBackendAvailable(backend))) {
        continue;
      }

      try {
        const sample = await readLinuxGpuSampleForBackend(backend);

        if (!sample) {
          continue;
        }

        if (backend !== preferredBackend) {
          backendPromise = Promise.resolve(backend);
        }

        return sample;
      } catch {
        continue;
      }
    }

    return undefined;
  }

  return {
    async readSample() {
      let backend: GpuBackend;

      try {
        backend = await (backendPromise ??= detectGpuBackend());
      } catch {
        backendPromise = Promise.resolve('none');
        return undefined;
      }

      if (backend === 'none') {
        return undefined;
      }

      try {
        switch (backend) {
          case 'windows-counters':
            windowsMetadataPromise ??= readWindowsGpuMetadata().catch(() => []);
            cachedSample = await readWindowsGpuSample(cachedSample, windowsMetadataPromise, displayConfig) ?? cachedSample;
            return cachedSample;
          case 'linux-nvidia-smi':
          case 'linux-rocm-smi':
          case 'linux-amdgpu-sysfs':
            cachedSample = await readLinuxGpuSample(backend) ?? cachedSample;
            return cachedSample;
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
      windowsMetadataPromise = undefined;
      linuxBackendAvailability.clear();
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

      if (await hasAmdGpuSysfsSupport()) {
        return 'linux-amdgpu-sysfs';
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
  windowsMetadataPromise: Promise<WindowsGpuMetadata[]>,
  displayConfig: GpuDisplayConfig,
): Promise<GpuAggregateSample | undefined> {
  const [counterSnapshot, metadataEntries] = await Promise.all([
    readWindowsCounterSnapshot(),
    windowsMetadataPromise,
  ]);
  const utilizationRows = counterSnapshot.utilizationRows;
  const memoryRows = counterSnapshot.memoryRows;
  const deviceMap = new Map<string, GpuDeviceSample & { isPhysical?: boolean }>(
    previousSample?.devices.map((device) => [device.id, { ...device }]) ?? [],
  );

  if (utilizationRows.length === 0 && memoryRows.length === 0 && deviceMap.size > 0) {
    return previousSample;
  }

  if (utilizationRows.length > 0) {
    for (const device of deviceMap.values()) {
      device.utilizationPercent = undefined;
    }
  }

  if (memoryRows.length > 0) {
    for (const device of deviceMap.values()) {
      device.memoryUsedBytes = undefined;
      device.memoryPercent = undefined;
    }
  }

  mergeWindowsCounterRows(deviceMap, utilizationRows, 'utilization');
  mergeWindowsCounterRows(deviceMap, memoryRows, 'memory');

  return createAggregateGpuSample(
    applyWindowsMetadataAndFilter([...deviceMap.values()], metadataEntries)
      .map((device, index) => ({
        ...device,
        index,
        memoryPercent:
          device.memoryUsedBytes !== undefined && device.memoryTotalBytes !== undefined
            ? calculateMemoryPercent(device.memoryUsedBytes, device.memoryTotalBytes)
            : undefined,
      })),
    displayConfig,
  );
}

async function readNvidiaSmiGpuSample(displayConfig: GpuDisplayConfig): Promise<GpuAggregateSample | undefined> {
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

  return createAggregateGpuSample(devices, displayConfig);
}

async function readRocmSmiGpuSample(
  cachedMemoryByDeviceId: Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>,
  nextMemoryRefreshAt: number,
  displayConfig: GpuDisplayConfig,
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
  const shouldRefreshMemory = Date.now() >= nextMemoryRefreshAt;
  const nextMemoryCache = shouldRefreshMemory ? new Map<string, Pick<GpuDeviceSample, 'memoryUsedBytes' | 'memoryTotalBytes' | 'memoryPercent'>>() : cachedMemoryByDeviceId;

  for (const [deviceKey, values] of Object.entries(parsed)) {
    const indexMatch = deviceKey.match(/\d+/);
    const index = indexMatch ? Number(indexMatch[0]) : devices.length;
    const id = `rocm-${index}`;
    const name = values['Card series'] ?? values['Card SKU'] ?? `GPU ${index}`;
    const utilizationPercent = parsePercentField(values, ['GPU use (%)', 'GPU use']);

    let memoryUsedBytes = cachedMemoryByDeviceId.get(id)?.memoryUsedBytes;
    let memoryTotalBytes = cachedMemoryByDeviceId.get(id)?.memoryTotalBytes;

    if (shouldRefreshMemory) {
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
    sample: createAggregateGpuSample(devices, displayConfig),
    memoryCache: nextMemoryCache,
    nextMemoryRefreshAt: shouldRefreshMemory ? Date.now() + GPU_MEMORY_REFRESH_MS : nextMemoryRefreshAt,
  };
}

async function hasAmdGpuSysfsSupport(): Promise<boolean> {
  try {
    const cards = await listAmdGpuSysfsCards();

    for (const card of cards) {
      if (await hasAmdGpuSysfsTelemetry(card.devicePath)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function readAmdGpuSysfsSample(displayConfig: GpuDisplayConfig): Promise<GpuAggregateSample | undefined> {
  const cards = await listAmdGpuSysfsCards();
  const devices = await Promise.all(cards.map(readAmdGpuSysfsDevice));
  return createAggregateGpuSample(devices.filter((device): device is GpuDeviceSample => device !== undefined), displayConfig);
}

async function listAmdGpuSysfsCards(): Promise<LinuxSysfsGpuInfo[]> {
  const entries = await readdir('/sys/class/drm', { withFileTypes: true });
  const cards = entries
    .filter((entry) => entry.isSymbolicLink() && /^card\d+$/.test(entry.name))
    .map((entry) => ({
      cardName: entry.name,
      cardPath: `/sys/class/drm/${entry.name}`,
      devicePath: `/sys/class/drm/${entry.name}/device`,
    }));
  const cardsWithDrivers = await Promise.all(cards.map(async (card) => {
    const driver = await readSysfsTextFile(`${card.devicePath}/uevent`);

    if (!driver.includes('DRIVER=amdgpu')) {
      return undefined;
    }

    return card;
  }));

  return cardsWithDrivers.filter((card): card is LinuxSysfsGpuInfo => card !== undefined);
}

async function readAmdGpuSysfsDevice(card: LinuxSysfsGpuInfo): Promise<GpuDeviceSample | undefined> {
  const indexMatch = card.cardName.match(/\d+/);
  const index = indexMatch ? Number(indexMatch[0]) : 0;
  const [vendorId, deviceId, utilizationPercent, memoryUsedBytes, memoryTotalBytes, slotName, productName] = await Promise.all([
    readSysfsTextFile(`${card.devicePath}/vendor`),
    readSysfsTextFile(`${card.devicePath}/device`),
    readSysfsNumberFile(`${card.devicePath}/gpu_busy_percent`),
    readSysfsNumberFile(`${card.devicePath}/mem_info_vram_used`),
    readSysfsNumberFile(`${card.devicePath}/mem_info_vram_total`),
    readSysfsUeventField(`${card.devicePath}/uevent`, 'PCI_SLOT_NAME'),
    readFirstSysfsTextFile([
      `${card.devicePath}/product_name`,
      `${card.devicePath}/product_number`,
    ]),
  ]);

  const normalizedVendorId = vendorId.toLowerCase();

  if (normalizedVendorId && normalizedVendorId !== '0x1002') {
    return undefined;
  }

  const resolvedName = createAmdSysfsGpuName(productName, deviceId, slotName);
  const resolvedMemoryTotalBytes = memoryTotalBytes !== undefined && memoryTotalBytes > 0 ? memoryTotalBytes : undefined;

  if (utilizationPercent === undefined && memoryUsedBytes === undefined) {
    return undefined;
  }

  return {
    id: `amdgpu-${slotName || card.cardName}`,
    index,
    name: resolvedName,
    category: isAmdIntegratedGpu(resolvedName.toLowerCase(), resolvedMemoryTotalBytes) ? 'integrated' : 'discrete',
    utilizationPercent,
    memoryUsedBytes,
    memoryTotalBytes: resolvedMemoryTotalBytes,
    memoryPercent:
      memoryUsedBytes !== undefined && resolvedMemoryTotalBytes !== undefined
        ? calculateMemoryPercent(memoryUsedBytes, resolvedMemoryTotalBytes)
        : undefined,
  };
}

function createAmdSysfsGpuName(productName: string, deviceId: string, slotName: string): string {
  const normalizedProductName = productName.trim();

  if (normalizedProductName) {
    return normalizedProductName;
  }

  if (deviceId) {
    return `AMD Radeon Graphics (${deviceId.replace(/^0x/i, '')}${slotName ? ` @ ${slotName}` : ''})`;
  }

  return slotName ? `AMD Radeon Graphics @ ${slotName}` : 'AMD Radeon Graphics';
}

async function hasAmdGpuSysfsTelemetry(devicePath: string): Promise<boolean> {
  const [utilizationValue, memoryUsedValue] = await Promise.all([
    readSysfsTextFile(`${devicePath}/gpu_busy_percent`),
    readSysfsTextFile(`${devicePath}/mem_info_vram_used`),
  ]);

  return Boolean(utilizationValue || memoryUsedValue);
}

async function readFirstSysfsTextFile(paths: string[]): Promise<string> {
  for (const path of paths) {
    const value = await readSysfsTextFile(path);

    if (value) {
      return value;
    }
  }

  return '';
}

async function readSysfsUeventField(path: string, key: string): Promise<string> {
  const contents = await readSysfsTextFile(path);

  if (!contents) {
    return '';
  }

  const prefix = `${key}=`;
  const line = contents
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(prefix));

  return line ? line.slice(prefix.length).trim() : '';
}

async function readSysfsTextFile(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function readSysfsNumberFile(path: string): Promise<number | undefined> {
  const value = await readSysfsTextFile(path);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractWindowsGpuDeviceId(instanceName: string): string | undefined {
  const match = instanceName.match(/luid_[^_]+_[^_]+_phys_\d+/);
  return match?.[0];
}

async function readWindowsCounterSnapshot(): Promise<{
  utilizationRows: GpuCounterSampleRow[];
  memoryRows: GpuCounterSampleRow[];
}> {
  const script = [
    'function Convert-GpuCounterSamples {',
    '  param($samples)',
    '  $samples | ForEach-Object {',
    '    $instanceName = [string]$_.InstanceName',
    "    if ($instanceName -match '(luid_[^_]+_[^_]+_phys_\\d+)') {",
    '      [PSCustomObject]@{',
    '        DeviceId = $Matches[1]',
    '        CookedValue = [double]$_.CookedValue',
    '      }',
    '    }',
    '  } | Group-Object DeviceId | ForEach-Object {',
    '    [PSCustomObject]@{',
    '      InstanceName = $_.Name',
    '      CookedValue = [double](($_.Group | Measure-Object -Property CookedValue -Maximum).Maximum)',
    '    }',
    '  }',
    '}',
    "$util = Convert-GpuCounterSamples ((Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples)",
    "$memory = Convert-GpuCounterSamples ((Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples)",
    '[PSCustomObject]@{ Utilization = $util; Memory = $memory } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: WINDOWS_GPU_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const raw = stdout.trim();

  if (!raw) {
    return {
      utilizationRows: [],
      memoryRows: [],
    };
  }

  const parsed = JSON.parse(raw) as GpuCounterSnapshot;

  return {
    utilizationRows: toArray(parsed.Utilization),
    memoryRows: toArray(parsed.Memory),
  };
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

async function readWindowsGpuMetadata(): Promise<WindowsGpuMetadata[]> {
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
    '    MatchingDeviceId = [string]$_.MatchingDeviceId',
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
    return [];
  }

  const metadataRows = toArray(JSON.parse(raw) as Array<{ Name?: string; MemoryTotalBytes?: number; MatchingDeviceId?: string }> | { Name?: string; MemoryTotalBytes?: number; MatchingDeviceId?: string });
  return metadataRows
    .map((row) => ({
      name: typeof row.Name === 'string' ? row.Name.trim() : '',
      memoryTotalBytes: typeof row.MemoryTotalBytes === 'number' && Number.isFinite(row.MemoryTotalBytes) ? row.MemoryTotalBytes : undefined,
      isPhysical: isPhysicalWindowsAdapter(row.MatchingDeviceId),
    }))
    .filter((row) => row.name);
}

function toArray<T>(value: T[] | T | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function applyWindowsMetadataAndFilter(
  devices: Array<GpuDeviceSample & { isPhysical?: boolean }>,
  metadataEntries: WindowsGpuMetadata[],
): GpuDeviceSample[] {
  if (devices.length === 0) {
    return [];
  }

  const rankedDevices = [...devices].sort(compareWindowsDevicePriority);
  const physicalMetadata = metadataEntries.filter((metadata) => metadata.isPhysical);
  const nonPhysicalMetadata = metadataEntries.filter((metadata) => !metadata.isPhysical);

  for (const [index, metadata] of physicalMetadata.entries()) {
    const device = rankedDevices[index];

    if (!device) {
      break;
    }

    device.isPhysical = true;
    device.name = metadata.name ?? device.name;

    if (metadata.memoryTotalBytes !== undefined) {
      device.memoryTotalBytes = metadata.memoryTotalBytes;
    }
  }

  const remainingDevices = rankedDevices.filter((device) => device.isPhysical === undefined).reverse();

  for (const [index, metadata] of nonPhysicalMetadata.entries()) {
    const device = remainingDevices[index];

    if (!device) {
      break;
    }

    device.isPhysical = false;
    device.name = metadata.name ?? device.name;
  }

  return devices
    .filter((device) => device.isPhysical !== false)
    .sort((left, right) => left.index - right.index)
    .map(({ isPhysical, ...device }) => device);
}

function compareWindowsDevicePriority(
  left: GpuDeviceSample & { isPhysical?: boolean },
  right: GpuDeviceSample & { isPhysical?: boolean },
): number {
  const leftHasMemory = (left.memoryUsedBytes ?? 0) > 0 ? 1 : 0;
  const rightHasMemory = (right.memoryUsedBytes ?? 0) > 0 ? 1 : 0;

  if (rightHasMemory !== leftHasMemory) {
    return rightHasMemory - leftHasMemory;
  }

  const rightUtilization = right.utilizationPercent ?? 0;
  const leftUtilization = left.utilizationPercent ?? 0;

  if (rightUtilization !== leftUtilization) {
    return rightUtilization - leftUtilization;
  }

  const rightMemory = right.memoryUsedBytes ?? 0;
  const leftMemory = left.memoryUsedBytes ?? 0;

  if (rightMemory !== leftMemory) {
    return rightMemory - leftMemory;
  }

  return left.id.localeCompare(right.id);
}

function isPhysicalWindowsAdapter(matchingDeviceId: string | undefined): boolean {
  const normalizedDeviceId = matchingDeviceId?.trim().toUpperCase() ?? '';

  if (!normalizedDeviceId) {
    return true;
  }

  return !normalizedDeviceId.startsWith('ROOT\\');
}

function createAggregateGpuSample(devices: GpuDeviceSample[], displayConfig: GpuDisplayConfig): GpuAggregateSample | undefined {
  const normalizedDevices = devices
    .map((device, index) => ({
      ...device,
      index,
      utilizationPercent: device.utilizationPercent !== undefined ? clampPercent(device.utilizationPercent) : undefined,
      memoryPercent:
        device.memoryUsedBytes !== undefined && device.memoryTotalBytes !== undefined
          ? calculateMemoryPercent(device.memoryUsedBytes, device.memoryTotalBytes)
          : device.memoryPercent,
      category: device.category ?? classifyGpuDevice(device, displayConfig.categoryOverrides),
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

  const allSummary = createGpuSummary(normalizedDevices, 'all', createAllGpuSummaryLabel(normalizedDevices), 'average');
  const integratedDevices = normalizedDevices.filter((device) => device.category === 'integrated');
  const discreteDevices = normalizedDevices.filter((device) => device.category === 'discrete');
  const unknownDevices = normalizedDevices.filter((device) => device.category === 'unknown');
  const integratedSummary = integratedDevices.length > 0
    ? createGpuSummary(integratedDevices, 'integrated', createCategorySummaryLabel('integrated', integratedDevices.length), 'max')
    : undefined;
  const discreteSummary = discreteDevices.length > 0
    ? createGpuSummary(discreteDevices, 'discrete', createCategorySummaryLabel('discrete', discreteDevices.length), 'max')
    : undefined;
  const unknownSummary = unknownDevices.length > 0
    ? createGpuSummary(unknownDevices, 'unknown', createCategorySummaryLabel('unknown', unknownDevices.length), 'max')
    : undefined;
  const selectedSummary = selectGpuSummary(normalizedDevices, {
    all: allSummary,
    integrated: integratedSummary,
    discrete: discreteSummary,
    unknown: unknownSummary,
  }, displayConfig);

  return {
    devices: normalizedDevices,
    summary: selectedSummary,
    groups: {
      all: allSummary,
      integrated: integratedSummary,
      discrete: discreteSummary,
      unknown: unknownSummary,
    },
    aggregateUtilizationPercent: allSummary.utilizationPercent,
    aggregateMemoryUsedBytes: allSummary.memoryUsedBytes,
    aggregateMemoryTotalBytes: allSummary.memoryTotalBytes,
    aggregateMemoryPercent: allSummary.memoryPercent,
    hasAnyMemoryData: normalizedDevices.some((device) => device.memoryUsedBytes !== undefined || device.memoryTotalBytes !== undefined),
  };
}

function classifyGpuDevice(
  device: Pick<GpuDeviceSample, 'id' | 'index' | 'name' | 'memoryTotalBytes'>,
  categoryOverrides: Record<string, GpuDeviceCategory>,
): GpuDeviceCategory {
  const overriddenCategory = findOverriddenGpuCategory(device, categoryOverrides);

  if (overriddenCategory) {
    return overriddenCategory;
  }

  const normalizedName = device.name.trim().toLowerCase();

  if (!normalizedName) {
    return 'unknown';
  }

  if (isIntelGpu(normalizedName)) {
    return isIntelDiscreteGpu(normalizedName) ? 'discrete' : 'integrated';
  }

  if (isNvidiaGpu(normalizedName)) {
    return 'discrete';
  }

  if (isAmdGpu(normalizedName)) {
    return isAmdIntegratedGpu(normalizedName, device.memoryTotalBytes) ? 'integrated' : 'discrete';
  }

  return 'unknown';
}

function findOverriddenGpuCategory(
  device: Pick<GpuDeviceSample, 'id' | 'index' | 'name'>,
  categoryOverrides: Record<string, GpuDeviceCategory>,
): GpuDeviceCategory | undefined {
  for (const [matcher, category] of Object.entries(categoryOverrides)) {
    if (gpuDeviceMatchesMatcher(device, matcher)) {
      return category;
    }
  }

  return undefined;
}

function isIntelGpu(name: string): boolean {
  return name.includes('intel');
}

function isIntelDiscreteGpu(name: string): boolean {
  return /(arc|iris xe max|data center gpu|flex)/.test(name);
}

function isNvidiaGpu(name: string): boolean {
  return /(nvidia|geforce|quadro|tesla|rtx|gtx)/.test(name);
}

function isAmdGpu(name: string): boolean {
  return /(amd|radeon|ati|firepro|instinct)/.test(name);
}

function isAmdIntegratedGpu(name: string, memoryTotalBytes: number | undefined): boolean {
  if (/(radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|680m|760m|780m|880m|890m)/.test(name)) {
    return true;
  }

  if (/(rx\s|radeon pro|firepro|instinct|mi\d|w\d{3,4}|wx)/.test(name)) {
    return false;
  }

  return memoryTotalBytes !== undefined && memoryTotalBytes > 0 && memoryTotalBytes <= 2 * 1024 ** 3;
}

function createGpuSummary(
  devices: GpuDeviceSample[],
  id: string,
  label: string,
  utilizationMode: 'average' | 'max',
): GpuSummarySample {
  const utilizationDevices = devices.filter((device) => device.utilizationPercent !== undefined);
  const utilizationPercent =
    utilizationDevices.length > 0
      ? utilizationMode === 'average'
        ? utilizationDevices.reduce((sum, device) => sum + (device.utilizationPercent ?? 0), 0) / utilizationDevices.length
        : utilizationDevices.reduce((maxValue, device) => Math.max(maxValue, device.utilizationPercent ?? 0), 0)
      : 0;
  const memoryDevicesWithUsed = devices.filter((device) => device.memoryUsedBytes !== undefined);
  const memoryUsedBytes = memoryDevicesWithUsed.length > 0
    ? memoryDevicesWithUsed.reduce((sum, device) => sum + (device.memoryUsedBytes ?? 0), 0)
    : undefined;
  const devicesWithMemoryTotals = devices.filter((device) => device.memoryTotalBytes !== undefined && device.memoryTotalBytes > 0);
  const hasCompleteMemoryTotal = memoryDevicesWithUsed.length > 0 && devicesWithMemoryTotals.length === devices.length;
  const memoryTotalBytes = hasCompleteMemoryTotal
    ? devicesWithMemoryTotals.reduce((sum, device) => sum + (device.memoryTotalBytes ?? 0), 0)
    : undefined;
  const summaryCategory = devices.length === 1
    ? devices[0].category ?? 'unknown'
    : getSummaryCategory(devices);

  return {
    id,
    label,
    category: summaryCategory,
    deviceCount: devices.length,
    deviceIds: devices.map((device) => device.id),
    utilizationPercent,
    memoryUsedBytes,
    memoryTotalBytes,
    memoryPercent:
      memoryUsedBytes !== undefined && memoryTotalBytes !== undefined && memoryTotalBytes > 0
        ? calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes)
        : undefined,
  };
}

function getSummaryCategory(devices: GpuDeviceSample[]): GpuDeviceCategory | 'mixed' {
  if (devices.length === 0) {
    return 'mixed';
  }

  const categories = new Set(devices.map((device) => device.category ?? 'unknown'));

  return categories.size === 1 ? (devices[0].category ?? 'unknown') : 'mixed';
}

function selectGpuSummary(
  devices: GpuDeviceSample[],
  groups: {
    all: GpuSummarySample;
    integrated?: GpuSummarySample;
    discrete?: GpuSummarySample;
    unknown?: GpuSummarySample;
  },
  displayConfig: GpuDisplayConfig,
): GpuSummarySample {
  const automaticSummary = selectDefaultGpuSummary(devices, groups);

  switch (displayConfig.summaryMode) {
    case 'discrete':
      return groups.discrete ?? createUnavailableGpuSummary('discrete');
    case 'integrated':
      return groups.integrated ?? createUnavailableGpuSummary('integrated');
    case 'selected': {
      const selectedSummary = selectConfiguredGpuSummary(devices, displayConfig.selectedDeviceMatchers);
      return selectedSummary ?? createUnavailableGpuSummary('selected');
    }
    case 'auto':
    default:
      return automaticSummary;
  }
}

function createUnavailableGpuSummary(mode: 'discrete' | 'integrated' | 'selected'): GpuSummarySample {
  switch (mode) {
    case 'discrete':
      return {
        id: 'unavailable-discrete',
        label: 'dGPU',
        category: 'discrete',
        deviceCount: 0,
        deviceIds: [],
        utilizationPercent: 0,
      };
    case 'integrated':
      return {
        id: 'unavailable-integrated',
        label: 'iGPU',
        category: 'integrated',
        deviceCount: 0,
        deviceIds: [],
        utilizationPercent: 0,
      };
    case 'selected':
    default:
      return {
        id: 'unavailable-selected',
        label: 'Selected GPU',
        category: 'mixed',
        deviceCount: 0,
        deviceIds: [],
        utilizationPercent: 0,
      };
  }
}

function selectDefaultGpuSummary(
  devices: GpuDeviceSample[],
  groups: {
    all: GpuSummarySample;
    integrated?: GpuSummarySample;
    discrete?: GpuSummarySample;
    unknown?: GpuSummarySample;
  },
): GpuSummarySample {
  const discreteDevices = devices.filter((device) => device.category === 'discrete');

  if (discreteDevices.length > 0) {
    const activeDiscreteDevices = discreteDevices.filter(isGpuDeviceActive);

    if (activeDiscreteDevices.length === 1) {
      return createSingleDeviceSummary(activeDiscreteDevices[0]);
    }

    if (activeDiscreteDevices.length > 1) {
      return createGpuSummary(
        activeDiscreteDevices,
        'active-discrete',
        createCategorySummaryLabel('discrete', activeDiscreteDevices.length),
        'max',
      );
    }

    return groups.discrete ?? groups.all;
  }

  const integratedDevices = devices.filter((device) => device.category === 'integrated');

  if (integratedDevices.length > 0) {
    const activeIntegratedDevices = integratedDevices.filter(isGpuDeviceActive);

    if (activeIntegratedDevices.length === 1) {
      return createSingleDeviceSummary(activeIntegratedDevices[0]);
    }

    if (activeIntegratedDevices.length > 1) {
      return createGpuSummary(
        activeIntegratedDevices,
        'active-integrated',
        createCategorySummaryLabel('integrated', activeIntegratedDevices.length),
        'max',
      );
    }

    return groups.integrated ?? groups.all;
  }

  return groups.unknown ?? groups.all;
}

function selectConfiguredGpuSummary(devices: GpuDeviceSample[], matchers: string[]): GpuSummarySample | undefined {
  if (matchers.length === 0) {
    return undefined;
  }

  const selectedDevices = devices.filter((device) => matchers.some((matcher) => gpuDeviceMatchesMatcher(device, matcher)));

  if (selectedDevices.length === 0) {
    return undefined;
  }

  if (selectedDevices.length === 1) {
    return createSingleDeviceSummary(selectedDevices[0]);
  }

  return createGpuSummary(
    selectedDevices,
    'selected',
    createSelectedGpuSummaryLabel(selectedDevices),
    'max',
  );
}

function createSingleDeviceSummary(device: GpuDeviceSample): GpuSummarySample {
  return {
    id: device.id,
    label: createSingleDeviceSummaryLabel(device),
    category: device.category ?? 'unknown',
    deviceCount: 1,
    deviceIds: [device.id],
    utilizationPercent: device.utilizationPercent ?? 0,
    memoryUsedBytes: device.memoryUsedBytes,
    memoryTotalBytes: device.memoryTotalBytes,
    memoryPercent: device.memoryPercent,
  };
}

function createSingleDeviceSummaryLabel(device: GpuDeviceSample): string {
  switch (device.category) {
    case 'discrete':
      return `dGPU ${device.index}`;
    case 'integrated':
      return `iGPU ${device.index}`;
    default:
      return `GPU ${device.index}`;
  }
}

function createAllGpuSummaryLabel(devices: GpuDeviceSample[]): string {
  return devices.length > 1 ? `GPU×${devices.length}` : 'GPU';
}

function createSelectedGpuSummaryLabel(devices: GpuDeviceSample[]): string {
  const category = getSummaryCategory(devices);

  if (category === 'discrete' || category === 'integrated' || category === 'unknown') {
    return createCategorySummaryLabel(category, devices.length);
  }

  return createAllGpuSummaryLabel(devices);
}

function createCategorySummaryLabel(category: GpuDeviceCategory, count: number): string {
  switch (category) {
    case 'discrete':
      return count > 1 ? `dGPU×${count}` : 'dGPU';
    case 'integrated':
      return count > 1 ? `iGPU×${count}` : 'iGPU';
    default:
      return count > 1 ? `GPU×${count}` : 'GPU';
  }
}

function isGpuDeviceActive(device: GpuDeviceSample): boolean {
  return (device.utilizationPercent ?? 0) >= ACTIVE_GPU_UTILIZATION_THRESHOLD_PERCENT
    || (device.memoryPercent ?? 0) >= ACTIVE_GPU_MEMORY_THRESHOLD_PERCENT
    || (device.memoryUsedBytes ?? 0) >= ACTIVE_GPU_MEMORY_THRESHOLD_BYTES;
}

export function gpuDeviceMatchesMatcher(device: Pick<GpuDeviceSample, 'id' | 'index' | 'name'>, matcher: string): boolean {
  const normalizedMatcher = matcher.trim().toLowerCase();

  if (!normalizedMatcher) {
    return false;
  }

  const candidates = [
    device.name,
    device.id,
    String(device.index),
    `gpu ${device.index}`,
  ].map((value) => value.trim().toLowerCase());

  return candidates.some((candidate) => candidate.includes(normalizedMatcher));
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
