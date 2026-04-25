import * as vscode from 'vscode';
import { TOP_CPU_PROCESS_COUNT, TOP_MEMORY_PROCESS_COUNT, RANK_LABELS } from './constants.js';
import { readGpuDisplayConfig, writeGpuDisplayConfig } from './config.js';
import { gpuDeviceMatchesMatcher } from './gpu.js';
import { readTopCpuProcesses, readTopMemoryProcesses } from './processes.js';
import type { CpuProcess, GpuAggregateSample, GpuDeviceCategory, GpuDeviceSample, GpuDisplayConfig, GpuSummaryMode, MemoryProcess } from './types.js';
import {
  formatPercent,
  formatBytes,
  formatPrecisePercent,
  formatProcessName,
  formatProcessCpuPercent,
  formatStorageUsage,
  normalizeTopProcessCpuPercents,
} from './utils.js';

type GpuConfigurationAction = 'set-mode' | 'select-devices' | 'override-category' | 'clear-category-overrides';

type GpuConfigurationQuickPickItem = vscode.QuickPickItem & {
  action: GpuConfigurationAction;
  mode?: GpuSummaryMode;
  isCurrent?: boolean;
};

type GpuDeviceQuickPickItem = vscode.QuickPickItem & {
  device: GpuDeviceSample;
  overrideKey?: string;
};

type GpuCategoryQuickPickItem = vscode.QuickPickItem & {
  category: GpuDeviceCategory | 'automatic';
  isCurrent?: boolean;
};

export interface CommandHandlers {
  showTopCpuProcesses(): Promise<void>;
  showTopMemoryProcesses(): Promise<void>;
  configureGpuDisplay(): Promise<void>;
}

export function createCommandHandlers(
  getLatestMetrics: () => { cpuPercent: number; memoryPercent: number; memoryUsedBytes: number },
  readLatestGpu: () => Promise<GpuAggregateSample | undefined>,
  onGpuDisplayConfigChanged: () => void,
): CommandHandlers {
  let cpuProcessesCommandInProgress = false;
  let memoryProcessesCommandInProgress = false;
  let gpuConfigurationCommandInProgress = false;

  return {
    async showTopCpuProcesses() {
      if (cpuProcessesCommandInProgress) {
        return;
      }

      cpuProcessesCommandInProgress = true;
      const { cpuPercent } = getLatestMetrics();
      const quickPick = vscode.window.createQuickPick();
      let quickPickDisposed = false;
      quickPick.title = `Top ${TOP_CPU_PROCESS_COUNT} CPU Processes - CPU ${formatPercent(cpuPercent)}`;
      quickPick.placeholder = 'Collecting process data...';
      quickPick.busy = true;
      quickPick.items = [{ label: 'Collecting process data...' }];
      quickPick.onDidHide(() => {
        quickPickDisposed = true;
        quickPick.dispose();
      });
      quickPick.show();

      try {
        const topCpuProcesses = await readTopCpuProcesses();
        const { cpuPercent: latestCpuPercent } = getLatestMetrics();

        if (quickPickDisposed) {
          return;
        }

        const items =
          topCpuProcesses.length > 0
            ? normalizeTopProcessCpuPercents(topCpuProcesses, latestCpuPercent).map((process, index) => ({
                label: `${RANK_LABELS[index] ?? `${index + 1}.`} ${formatProcessName(process.name)}`,
                description: formatProcessCpuPercent(process.cpuPercent),
              }))
            : [{ label: 'No process data available' }];

        quickPick.title = `Top ${TOP_CPU_PROCESS_COUNT} CPU Processes - CPU ${formatPercent(latestCpuPercent)}`;
        quickPick.placeholder = 'Collected when this list opens.';
        quickPick.items = items;
      } finally {
        if (!quickPickDisposed) {
          quickPick.busy = false;
        }

        cpuProcessesCommandInProgress = false;
      }
    },

    async showTopMemoryProcesses() {
      if (memoryProcessesCommandInProgress) {
        return;
      }

      memoryProcessesCommandInProgress = true;

      try {
        const topMemoryProcesses = await readTopMemoryProcesses();
        const { memoryPercent, memoryUsedBytes } = getLatestMetrics();
        const items =
          topMemoryProcesses.length > 0
            ? topMemoryProcesses.map((process, index) => ({
                label: `${RANK_LABELS[index] ?? `${index + 1}.`} ${formatProcessName(process.name)}`,
                description: `${formatBytes(process.memoryBytes)} · ${formatProcessCpuPercent(process.memoryPercent)}`,
              }))
            : [{ label: 'No process data available' }];

        await vscode.window.showQuickPick(items, {
          title: `Top ${TOP_MEMORY_PROCESS_COUNT} Memory Processes - Memory ${formatBytes(memoryUsedBytes)} · ${formatPercent(memoryPercent)}`,
          placeHolder: 'Collected when this list opens.',
        });
      } finally {
        memoryProcessesCommandInProgress = false;
      }
    },

    async configureGpuDisplay() {
      if (gpuConfigurationCommandInProgress) {
        return;
      }

      gpuConfigurationCommandInProgress = true;

      try {
        const displayConfig = readGpuDisplayConfig();
        const action = await showSingleSelectQuickPick(buildGpuConfigurationItems(displayConfig), {
          title: 'Configure GPU Display',
          placeHolder: 'Choose what the GPU status bar item should summarize.',
        });

        if (!action) {
          return;
        }

        switch (action.action) {
          case 'set-mode':
            if (action.mode) {
              await persistGpuDisplayConfig({
                ...displayConfig,
                summaryMode: action.mode,
              }, onGpuDisplayConfigChanged);
            }
            return;
          case 'select-devices':
            await configureSelectedGpuDevices(displayConfig, readLatestGpu, onGpuDisplayConfigChanged);
            return;
          case 'override-category':
            await configureGpuCategoryOverride(displayConfig, readLatestGpu, onGpuDisplayConfigChanged);
            return;
          case 'clear-category-overrides':
            await persistGpuDisplayConfig({
              ...displayConfig,
              categoryOverrides: {},
            }, onGpuDisplayConfigChanged);
            return;
        }
      } finally {
        gpuConfigurationCommandInProgress = false;
      }
    },
  };
}

function buildGpuConfigurationItems(displayConfig: GpuDisplayConfig): GpuConfigurationQuickPickItem[] {
  const items: GpuConfigurationQuickPickItem[] = [
    {
      label: 'Auto',
      description: displayConfig.summaryMode === 'auto' ? 'Current' : undefined,
      detail: 'Prefer discrete GPUs when present and fall back automatically when they are missing or idle.',
      action: 'set-mode',
      mode: 'auto',
      isCurrent: displayConfig.summaryMode === 'auto',
    },
    {
      label: 'Discrete GPUs Only',
      description: displayConfig.summaryMode === 'discrete' ? 'Current' : undefined,
      detail: 'Summarize only detected discrete GPUs. Shows dGPU unavailable when none are detected.',
      action: 'set-mode',
      mode: 'discrete',
      isCurrent: displayConfig.summaryMode === 'discrete',
    },
    {
      label: 'Integrated GPUs Only',
      description: displayConfig.summaryMode === 'integrated' ? 'Current' : undefined,
      detail: 'Summarize only detected integrated GPUs. Shows iGPU unavailable when none are detected.',
      action: 'set-mode',
      mode: 'integrated',
      isCurrent: displayConfig.summaryMode === 'integrated',
    },
    {
      label: 'Choose GPUs...',
      description: getSelectedGpuModeDescription(displayConfig),
      detail: 'Pick zero or more detected GPUs. If no selected GPU is currently available, the summary shows Selected GPU unavailable.',
      action: 'select-devices',
      isCurrent: displayConfig.summaryMode === 'selected',
    },
    {
      label: 'Override a GPU Category...',
      description:
        Object.keys(displayConfig.categoryOverrides).length > 0
          ? `Current: ${Object.keys(displayConfig.categoryOverrides).length} override${Object.keys(displayConfig.categoryOverrides).length === 1 ? '' : 's'}`
          : undefined,
      detail: 'Choose a detected GPU and force it to be treated as integrated, discrete, or unknown.',
      action: 'override-category',
    },
  ];

  if (Object.keys(displayConfig.categoryOverrides).length > 0) {
    items.push({
      label: 'Clear GPU Category Overrides',
      description: `${Object.keys(displayConfig.categoryOverrides).length} configured`,
      detail: 'Remove all manual GPU category override rules.',
      action: 'clear-category-overrides',
    });
  }

  return items;
}

async function configureSelectedGpuDevices(
  displayConfig: GpuDisplayConfig,
  readLatestGpu: () => Promise<GpuAggregateSample | undefined>,
  onGpuDisplayConfigChanged: () => void,
): Promise<void> {
  const gpu = await loadLatestGpuForConfiguration(readLatestGpu);

  if (!gpu || gpu.devices.length === 0) {
    vscode.window.showWarningMessage('No GPU telemetry is available yet. Wait for the GPU item to appear and try again.');
    return;
  }

  const pickedItems = await vscode.window.showQuickPick(
    gpu.devices.map((device) => ({
      label: formatGpuDeviceLabel(device),
      description: formatGpuDeviceDescription(device),
      detail: `Backend id: ${device.id}`,
      picked: displayConfig.selectedDeviceMatchers.some((matcher) => gpuDeviceMatchesMatcher(device, matcher)),
      device,
    } satisfies GpuDeviceQuickPickItem)),
    {
      canPickMany: true,
      title: 'Select GPUs for the Status Bar',
      placeHolder: 'Choose zero or more detected GPUs. An empty selection keeps Selected GPU mode and shows Selected GPU unavailable.',
    },
  );

  if (!pickedItems) {
    return;
  }

  if (pickedItems.length === 0) {
    await persistGpuDisplayConfig({
      ...displayConfig,
      selectedDeviceMatchers: [],
      summaryMode: 'selected',
    }, onGpuDisplayConfigChanged);
    return;
  }

  await persistGpuDisplayConfig({
    ...displayConfig,
    selectedDeviceMatchers: pickedItems.map((item) => item.device.id),
    summaryMode: 'selected',
  }, onGpuDisplayConfigChanged);
}

async function configureGpuCategoryOverride(
  displayConfig: GpuDisplayConfig,
  readLatestGpu: () => Promise<GpuAggregateSample | undefined>,
  onGpuDisplayConfigChanged: () => void,
): Promise<void> {
  const gpu = await loadLatestGpuForConfiguration(readLatestGpu);

  if (!gpu || gpu.devices.length === 0) {
    vscode.window.showWarningMessage('No GPU telemetry is available yet. Wait for the GPU item to appear and try again.');
    return;
  }

  const deviceItem = await vscode.window.showQuickPick(
    gpu.devices.map((device) => {
      const overrideKey = findMatchingGpuOverrideKey(device, displayConfig.categoryOverrides);
      const overrideLabel = overrideKey ? `Override: ${formatGpuCategoryLabel(displayConfig.categoryOverrides[overrideKey])}` : 'Automatic detection';

      return {
        label: formatGpuDeviceLabel(device),
        description: `${formatGpuDeviceDescription(device)} · ${overrideLabel}`,
        detail: `Backend id: ${device.id}`,
        device,
        overrideKey,
      } satisfies GpuDeviceQuickPickItem;
    }),
    {
      title: 'Choose a GPU to Classify',
      placeHolder: 'Pick one detected GPU to override or reset its category.',
    },
  );

  if (!deviceItem) {
    return;
  }

  const categoryItem = await showSingleSelectQuickPick(buildGpuCategoryItems(deviceItem.device, deviceItem.overrideKey, displayConfig), {
    title: `Classify ${formatGpuDeviceLabel(deviceItem.device)}`,
    placeHolder: 'Choose how this GPU should be treated.',
  });

  if (!categoryItem) {
    return;
  }

  const nextOverrides = { ...displayConfig.categoryOverrides };
  delete nextOverrides[deviceItem.device.id];

  if (categoryItem.category === 'automatic') {
    await persistGpuDisplayConfig({
      ...displayConfig,
      categoryOverrides: nextOverrides,
    }, onGpuDisplayConfigChanged);

    return;
  }

  nextOverrides[deviceItem.device.id] = categoryItem.category;
  await persistGpuDisplayConfig({
    ...displayConfig,
    categoryOverrides: nextOverrides,
  }, onGpuDisplayConfigChanged);
}

function buildGpuCategoryItems(
  device: GpuDeviceSample,
  overrideKey: string | undefined,
  displayConfig: GpuDisplayConfig,
): GpuCategoryQuickPickItem[] {
  const effectiveOverride = overrideKey ? displayConfig.categoryOverrides[overrideKey] : undefined;
  const effectiveCategory = effectiveOverride ?? device.category;

  return [
    {
      label: 'Automatic Detection',
      description: effectiveOverride ? `Currently overridden as ${formatGpuCategoryLabel(effectiveOverride)}` : `Currently detected as ${formatGpuCategoryLabel(device.category)}`,
      detail: 'Remove the exact-device override and fall back to automatic category detection.',
      category: 'automatic',
      isCurrent: effectiveOverride === undefined,
    },
    {
      label: 'Discrete GPU',
      description: device.category === 'discrete' ? 'Current effective category' : undefined,
      detail: 'Use this when the device should participate in the discrete GPU summary group.',
      category: 'discrete',
      isCurrent: effectiveCategory === 'discrete',
    },
    {
      label: 'Integrated GPU',
      description: device.category === 'integrated' ? 'Current effective category' : undefined,
      detail: 'Use this when the device should participate in the integrated GPU summary group.',
      category: 'integrated',
      isCurrent: effectiveCategory === 'integrated',
    },
    {
      label: 'Unknown GPU',
      description: device.category === 'unknown' ? 'Current effective category' : undefined,
      detail: 'Use this when the device should stay outside both the integrated and discrete groups.',
      category: 'unknown',
      isCurrent: effectiveCategory === 'unknown',
    },
  ];
}

async function loadLatestGpuForConfiguration(
  readLatestGpu: () => Promise<GpuAggregateSample | undefined>,
): Promise<GpuAggregateSample | undefined> {
  return readLatestGpu();
}

function findMatchingGpuOverrideKey(
  device: Pick<GpuDeviceSample, 'id' | 'index' | 'name'>,
  categoryOverrides: Record<string, GpuDeviceCategory>,
): string | undefined {
  const exactMatch = Object.keys(categoryOverrides).find((matcher) => matcher.trim().toLowerCase() === device.id.trim().toLowerCase());

  if (exactMatch) {
    return exactMatch;
  }

  return Object.keys(categoryOverrides).find((matcher) => gpuDeviceMatchesMatcher(device, matcher));
}

function formatGpuDeviceLabel(device: GpuDeviceSample): string {
  return `GPU ${device.index} · ${device.name}`;
}

function formatGpuDeviceDescription(device: GpuDeviceSample): string {
  const memory = device.memoryUsedBytes !== undefined && device.memoryTotalBytes !== undefined
    ? `${formatStorageUsage(device.memoryUsedBytes, device.memoryTotalBytes)} VRAM`
    : device.memoryUsedBytes !== undefined
      ? `${formatBytes(device.memoryUsedBytes)} VRAM`
      : 'VRAM unavailable';

  return `${formatGpuCategoryLabel(device.category)} · ${formatPrecisePercent(device.utilizationPercent ?? 0)} · ${memory}`;
}

function formatGpuCategoryLabel(category: GpuDeviceCategory | undefined): string {
  switch (category) {
    case 'discrete':
      return 'dGPU';
    case 'integrated':
      return 'iGPU';
    default:
      return 'Unknown';
  }
}

function getSelectedGpuModeDescription(displayConfig: GpuDisplayConfig): string | undefined {
  if (displayConfig.summaryMode !== 'selected') {
    return undefined;
  }

  if (displayConfig.selectedDeviceMatchers.length === 0) {
    return 'Current: no selected GPUs';
  }

  return `Current: ${displayConfig.selectedDeviceMatchers.length} selected GPU${displayConfig.selectedDeviceMatchers.length === 1 ? '' : 's'}`;
}

async function persistGpuDisplayConfig(
  displayConfig: GpuDisplayConfig,
  onGpuDisplayConfigChanged: () => void,
): Promise<void> {
  await writeGpuDisplayConfig(displayConfig);
  onGpuDisplayConfigChanged();
}

async function showSingleSelectQuickPick<T extends vscode.QuickPickItem & { isCurrent?: boolean }>(
  items: T[],
  options: {
    title: string;
    placeHolder: string;
  },
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<T>();
    let resolved = false;
    const currentItem = items.find((item) => item.isCurrent);

    quickPick.title = options.title;
    quickPick.placeholder = options.placeHolder;
    quickPick.items = items;

    quickPick.onDidAccept(() => {
      resolved = true;
      const [selectedItem] = quickPick.selectedItems;
      const [activeItem] = quickPick.activeItems;
      resolve(selectedItem ?? activeItem);
      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolve(undefined);
      }

      quickPick.dispose();
    });

    quickPick.show();

    if (currentItem) {
      quickPick.activeItems = [currentItem];
    }
  });
}
