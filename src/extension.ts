import * as os from 'node:os';
import * as vscode from 'vscode';
import { CONFIG_SECTION, SHOW_CPU_PROCESSES_COMMAND, SHOW_MEMORY_PROCESSES_COMMAND } from './constants.js';
import { isExtensionEnabled, readRefreshIntervalMs } from './config.js';
import { sampleCpuPercent } from './cpu.js';
import { sampleMemory } from './memory.js';
import { createDiskSampler } from './disk.js';
import type { DiskSampler } from './disk.js';
import { createStatusBarManager } from './statusBar.js';
import type { StatusBarManager } from './statusBar.js';
import { createCommandHandlers } from './commands.js';
import type { CommandHandlers } from './commands.js';
import { readCpuSnapshot } from './utils.js';
import type { CpuSnapshot, ResourceSample } from './types.js';

let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let refreshInProgress = false;
let statusBarManager: StatusBarManager | undefined;
let diskSampler: DiskSampler | undefined;
let commandHandlers: CommandHandlers | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBarManager = createStatusBarManager();
  statusBarManager.createItems();
  context.subscriptions.push(statusBarManager.cpuStatusBarItem, statusBarManager.memoryStatusBarItem, statusBarManager.diskStatusBarItem);

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
  diskSampler = undefined;
  commandHandlers = undefined;
}

function applyConfiguration(): void {
  stopRefreshing();

  if (!isExtensionEnabled()) {
    statusBarManager?.hide();
    return;
  }

  const diskTargetPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  statusBarManager?.setDiskTargetPath(diskTargetPath);
  previousCpuSnapshot = readCpuSnapshot();
  diskSampler = createDiskSampler(diskTargetPath);
  statusBarManager?.reset();
  statusBarManager?.updateCpuTooltip();
  statusBarManager?.updateMemoryTooltip();
  statusBarManager?.updateDiskTooltip();
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
  if (!statusBarManager || !diskSampler) {
    return;
  }

  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;

  try {
    const cpuResult = sampleCpuPercent(previousCpuSnapshot);
    previousCpuSnapshot = cpuResult.snapshot;

    const memoryResult = sampleMemory();
    const disk = await diskSampler.readSample();

    if (!statusBarManager || !diskSampler) {
      return;
    }

    const sample: ResourceSample = {
      cpuPercent: cpuResult.cpuPercent,
      memoryPercent: memoryResult.memoryPercent,
      memoryUsedBytes: memoryResult.memoryUsedBytes,
      memoryTotalBytes: memoryResult.memoryTotalBytes,
      disk,
    };

    statusBarManager.update(sample);
  } finally {
    refreshInProgress = false;
  }
}
