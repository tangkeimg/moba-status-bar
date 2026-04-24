import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONFIG_SECTION, SHOW_CPU_PROCESSES_COMMAND, SHOW_MEMORY_PROCESSES_COMMAND } from './constants.js';
import { isExtensionEnabled, readEnabledMonitors, readRefreshIntervalMs } from './config.js';
import { sampleCpuPercent } from './cpu.js';
import { sampleMemory } from './memory.js';
import { createGpuSampler } from './gpu.js';
import type { GpuSampler } from './gpu.js';
import { createDiskSampler } from './disk.js';
import type { DiskSampler } from './disk.js';
import { createStatusBarManager } from './statusBar.js';
import type { StatusBarManager } from './statusBar.js';
import { createCommandHandlers } from './commands.js';
import type { CommandHandlers } from './commands.js';
import { readCpuSnapshot } from './utils.js';
import type { CpuSnapshot, EnabledMonitors, ResourceSample } from './types.js';

let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let refreshInProgress = false;
let statusBarManager: StatusBarManager | undefined;
let gpuSampler: GpuSampler | undefined;
let diskSampler: DiskSampler | undefined;
let commandHandlers: CommandHandlers | undefined;
let enabledMonitors: EnabledMonitors = { cpu: true, memory: true, gpu: true, disk: true };

export function activate(context: vscode.ExtensionContext): void {
  statusBarManager = createStatusBarManager();
  statusBarManager.createItems();
  context.subscriptions.push(
    statusBarManager.cpuStatusBarItem,
    statusBarManager.memoryStatusBarItem,
    statusBarManager.gpuStatusBarItem,
    statusBarManager.diskStatusBarItem,
  );

  commandHandlers = createCommandHandlers(() => statusBarManager!.getLatestMetrics());
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_CPU_PROCESSES_COMMAND, () => commandHandlers!.showTopCpuProcesses()),
    vscode.commands.registerCommand(SHOW_MEMORY_PROCESSES_COMMAND, () => commandHandlers!.showTopMemoryProcesses()),
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
  gpuSampler = enabledMonitors.gpu ? createGpuSampler() : undefined;
  diskSampler = undefined;

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

  if (!enabledMonitors.cpu && !enabledMonitors.memory && !enabledMonitors.gpu && !enabledMonitors.disk) {
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
    }

    if (enabledMonitors.disk && diskSampler) {
      sample.disk = await diskSampler.readSample();
    }

    if (!statusBarManager) {
      return;
    }

    statusBarManager.update(sample);
  } finally {
    refreshInProgress = false;
  }
}
