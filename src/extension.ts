import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONFIG_SECTION, CONFIGURE_GPU_DISPLAY_COMMAND, SHOW_CPU_PROCESSES_COMMAND, SHOW_MEMORY_PROCESSES_COMMAND } from './constants.js';
import { initializeGpuDisplayConfigStorage, isExtensionEnabled, readEnabledMonitors, readGpuDisplayConfig, readRefreshIntervalMs } from './config.js';
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
let refreshInProgress = false;
let statusBarManager: StatusBarManager | undefined;
let gpuSampler: GpuSampler | undefined;
let diskSampler: DiskSampler | undefined;
let networkSampler: NetworkSampler | undefined;
let commandHandlers: CommandHandlers | undefined;
let enabledMonitors: EnabledMonitors = { cpu: true, memory: true, gpu: true, disk: true, network: true };
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
  stopRefreshing();
  statusBarManager?.dispose();
  statusBarManager = undefined;
  gpuSampler = undefined;
  diskSampler = undefined;
  networkSampler = undefined;
  commandHandlers = undefined;
}

function applyConfiguration(): void {
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
  gpuSampler = enabledMonitors.gpu ? createGpuSampler(readGpuDisplayConfig()) : undefined;
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

  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;

  try {
    const sample: ResourceSample = {};

    if (enabledMonitors.cpu) {
      const cpuResult = sampleCpuPercent(previousCpuSnapshot);
      previousCpuSnapshot = cpuResult.snapshot;
      sample.cpuPercent = cpuResult.cpuPercent;
    }

    if (enabledMonitors.memory) {
      const memoryResult = sampleMemory();
      sample.memoryPercent = memoryResult.memoryPercent;
      sample.memoryUsedBytes = memoryResult.memoryUsedBytes;
      sample.memoryTotalBytes = memoryResult.memoryTotalBytes;
    }

    if (enabledMonitors.gpu && gpuSampler) {
      sample.gpu = await gpuSampler.readSample();
      latestGpuSample = sample.gpu;
    }

    if (enabledMonitors.disk && diskSampler) {
      sample.disk = await diskSampler.readSample();
    }

    if (enabledMonitors.network && networkSampler) {
      sample.network = await networkSampler.readSample();
    }

    if (!statusBarManager) {
      return;
    }

    statusBarManager.update(sample);
  } finally {
    refreshInProgress = false;
  }
}
