import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONFIG_SECTION, CONFIGURE_GPU_DISPLAY_COMMAND, SHOW_CPU_PROCESSES_COMMAND, SHOW_MEMORY_PROCESSES_COMMAND } from './constants.js';
import { initializeGpuDisplayConfigStorage, isExtensionEnabled, readEnabledMonitors, readGpuDisplayConfig, readRefreshIntervalMs, readWindowsGpuBackend } from './config.js';
import { sampleCpuPercent } from './cpu.js';
import { sampleMemory } from './memory.js';
import { createGpuSampler } from './gpu.js';
import type { GpuSampler } from './gpu.js';
import { createDiskSampler } from './disk.js';
import type { DiskSampler } from './disk.js';
import { createNetworkSampler } from './network.js';
import type { NetworkSampler } from './network.js';
import { createStatusBarManager } from './statusBar.js';
import type { StatusBarManager } from './statusBar.js';
import { createCommandHandlers } from './commands.js';
import type { CommandHandlers } from './commands.js';
import { readCpuSnapshot } from './utils.js';
import type { CpuSnapshot, EnabledMonitors, GpuAggregateSample, ResourceSample } from './types.js';

let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let activeConfigurationGeneration = 0;
let refreshInProgressGeneration: number | undefined;
let gpuRefreshInProgressGeneration: number | undefined;
let diskRefreshInProgressGeneration: number | undefined;
let networkRefreshInProgressGeneration: number | undefined;
let statusBarManager: StatusBarManager | undefined;
let gpuSampler: GpuSampler | undefined;
let diskSampler: DiskSampler | undefined;
let networkSampler: NetworkSampler | undefined;
let commandHandlers: CommandHandlers | undefined;
let enabledMonitors: EnabledMonitors = { cpu: true, memory: true, gpu: true, disk: true, network: false };
let latestGpuSample: GpuAggregateSample | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initializeGpuDisplayConfigStorage(context);

  statusBarManager = createStatusBarManager();
  statusBarManager.createItems();
  context.subscriptions.push(
    statusBarManager.cpuStatusBarItem,
    statusBarManager.memoryStatusBarItem,
    statusBarManager.gpuStatusBarItem,
    statusBarManager.diskStatusBarItem,
    statusBarManager.networkStatusBarItem,
  );

  commandHandlers = createCommandHandlers(
    () => statusBarManager!.getLatestMetrics(),
    async () => {
      if (latestGpuSample) {
        return latestGpuSample;
      }

      if (!gpuSampler) {
        return undefined;
      }

      latestGpuSample = await gpuSampler.readSample();
      return latestGpuSample;
    },
    () => applyConfiguration(),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_CPU_PROCESSES_COMMAND, () => commandHandlers!.showTopCpuProcesses()),
    vscode.commands.registerCommand(SHOW_MEMORY_PROCESSES_COMMAND, () => commandHandlers!.showTopMemoryProcesses()),
    vscode.commands.registerCommand(CONFIGURE_GPU_DISPLAY_COMMAND, () => commandHandlers!.configureGpuDisplay()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        applyConfiguration();
      }
    }),
  );

  applyConfiguration();
}

export function deactivate(): void {
  activeConfigurationGeneration += 1;
  refreshInProgressGeneration = undefined;
  resetAsyncRefreshState();
  stopRefreshing();
  statusBarManager?.dispose();
  statusBarManager = undefined;
  gpuSampler = undefined;
  diskSampler = undefined;
  networkSampler = undefined;
  commandHandlers = undefined;
}

function applyConfiguration(): void {
  activeConfigurationGeneration += 1;
  refreshInProgressGeneration = undefined;
  resetAsyncRefreshState();
  stopRefreshing();

  if (!isExtensionEnabled()) {
    statusBarManager?.hide();
    return;
  }

  statusBarManager?.createItems();
  enabledMonitors = readEnabledMonitors();
  statusBarManager?.reset();
  statusBarManager?.setEnabledMonitors(enabledMonitors);

  previousCpuSnapshot = enabledMonitors.cpu ? readCpuSnapshot() : undefined;
  gpuSampler = enabledMonitors.gpu
    ? createGpuSampler(readGpuDisplayConfig(), { windowsBackend: readWindowsGpuBackend() })
    : undefined;
  latestGpuSample = undefined;
  diskSampler = undefined;
  networkSampler = enabledMonitors.network ? createNetworkSampler() : undefined;

  if (enabledMonitors.cpu) {
    statusBarManager?.updateCpuTooltip();
  }

  if (enabledMonitors.memory) {
    statusBarManager?.updateMemoryTooltip();
  }

  if (enabledMonitors.gpu) {
    statusBarManager?.updateGpuTooltip();
  }

  if (enabledMonitors.disk) {
    const diskTargetPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    statusBarManager?.setDiskTargetPath(diskTargetPath);
    diskSampler = createDiskSampler(diskTargetPath);
    statusBarManager?.updateDiskTooltip();
  }

  if (!enabledMonitors.cpu && !enabledMonitors.memory && !enabledMonitors.gpu && !enabledMonitors.disk && !enabledMonitors.network) {
    statusBarManager?.hide();
    return;
  }

  void updateStatusBar();

  const refreshIntervalMs = readRefreshIntervalMs();
  refreshTimer = setInterval(() => {
    void updateStatusBar();
  }, refreshIntervalMs);
}

function stopRefreshing(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

async function updateStatusBar(): Promise<void> {
  if (!statusBarManager) {
    return;
  }

  const generation = activeConfigurationGeneration;

  if (refreshInProgressGeneration === generation) {
    return;
  }

  refreshInProgressGeneration = generation;

  try {
    const monitors = enabledMonitors;
    const gpuSamplerForUpdate = gpuSampler;
    const diskSamplerForUpdate = diskSampler;
    const networkSamplerForUpdate = networkSampler;
    const immediateSample: ResourceSample = {};

    if (monitors.cpu) {
      const cpuResult = sampleCpuPercent(previousCpuSnapshot);
      previousCpuSnapshot = cpuResult.snapshot;
      immediateSample.cpuPercent = cpuResult.cpuPercent;
    }

    if (monitors.memory) {
      const memoryResult = sampleMemory();
      immediateSample.memoryPercent = memoryResult.memoryPercent;
      immediateSample.memoryUsedBytes = memoryResult.memoryUsedBytes;
      immediateSample.memoryTotalBytes = memoryResult.memoryTotalBytes;
    }

    if (hasSampleData(immediateSample) && generation === activeConfigurationGeneration) {
      statusBarManager.update(immediateSample);
    }

    if (monitors.gpu && gpuSamplerForUpdate) {
      startAsyncResourceSample(
        'gpu',
        generation,
        () => gpuSamplerForUpdate.readSample()
          .then((gpu): ResourceSample => {
            if (generation === activeConfigurationGeneration) {
              latestGpuSample = gpu;
            }

            return { gpu };
          }),
        { gpu: undefined },
      );
    }

    if (monitors.disk && diskSamplerForUpdate) {
      startAsyncResourceSample(
        'disk',
        generation,
        () => diskSamplerForUpdate.readSample()
          .then((disk): ResourceSample => ({ disk })),
        { disk: undefined },
      );
    }

    if (monitors.network && networkSamplerForUpdate) {
      startAsyncResourceSample(
        'network',
        generation,
        () => networkSamplerForUpdate.readSample()
          .then((network): ResourceSample => ({ network })),
        { network: undefined },
      );
    }
  } finally {
    if (refreshInProgressGeneration === generation) {
      refreshInProgressGeneration = undefined;
    }
  }
}

function hasSampleData(sample: ResourceSample): boolean {
  return Object.keys(sample).length > 0;
}

type AsyncResourceMonitor = 'gpu' | 'disk' | 'network';

function resetAsyncRefreshState(): void {
  gpuRefreshInProgressGeneration = undefined;
  diskRefreshInProgressGeneration = undefined;
  networkRefreshInProgressGeneration = undefined;
}

function startAsyncResourceSample(
  monitor: AsyncResourceMonitor,
  generation: number,
  readSample: () => Promise<ResourceSample>,
  fallbackSample: ResourceSample,
): void {
  if (getAsyncRefreshInProgressGeneration(monitor) === generation) {
    return;
  }

  setAsyncRefreshInProgressGeneration(monitor, generation);

  void Promise.resolve()
    .then(readSample)
    .catch(() => fallbackSample)
    .then((sample) => {
      if (!statusBarManager || generation !== activeConfigurationGeneration) {
        return;
      }

      statusBarManager.update(sample);
    })
    .finally(() => {
      if (getAsyncRefreshInProgressGeneration(monitor) === generation) {
        setAsyncRefreshInProgressGeneration(monitor, undefined);
      }
    });
}

function getAsyncRefreshInProgressGeneration(monitor: AsyncResourceMonitor): number | undefined {
  switch (monitor) {
    case 'gpu':
      return gpuRefreshInProgressGeneration;
    case 'disk':
      return diskRefreshInProgressGeneration;
    case 'network':
      return networkRefreshInProgressGeneration;
  }
}

function setAsyncRefreshInProgressGeneration(monitor: AsyncResourceMonitor, generation: number | undefined): void {
  switch (monitor) {
    case 'gpu':
      gpuRefreshInProgressGeneration = generation;
      return;
    case 'disk':
      diskRefreshInProgressGeneration = generation;
      return;
    case 'network':
      networkRefreshInProgressGeneration = generation;
      return;
  }
}
