import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  CPU_STATUS_PRIORITY,
  MEMORY_STATUS_PRIORITY,
  DISK_STATUS_PRIORITY,
  CPU_STATUS_PRIORITY_LEFT,
  MEMORY_STATUS_PRIORITY_LEFT,
  DISK_STATUS_PRIORITY_LEFT,
  SHOW_CPU_PROCESSES_COMMAND,
  SHOW_MEMORY_PROCESSES_COMMAND,
} from './constants.js';
import { readAlignment, readCpuTrendGraphConfig, readWarningThresholds } from './config.js';
import type { ResourceSample, DiskSample, EnabledMonitors } from './types.js';
import { formatPercent, formatStorageUsage, formatDiskUsage, calculateMemoryPercent, formatCpuTrendGraph } from './utils.js';

export interface StatusBarManager {
  readonly cpuStatusBarItem: vscode.StatusBarItem;
  readonly memoryStatusBarItem: vscode.StatusBarItem;
  readonly diskStatusBarItem: vscode.StatusBarItem;
  createItems(): void;
  update(sample: ResourceSample): void;
  updateCpuTooltip(): void;
  updateMemoryTooltip(): void;
  updateDiskTooltip(disk?: DiskSample): void;
  setEnabledMonitors(enabledMonitors: EnabledMonitors): void;
  setDiskTargetPath(diskTargetPath: string): void;
  getLatestMetrics(): { cpuPercent: number; memoryPercent: number; memoryUsedBytes: number };
  reset(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

export function createStatusBarManager(): StatusBarManager {
  let cpuStatusBarItem: vscode.StatusBarItem;
  let memoryStatusBarItem: vscode.StatusBarItem;
  let diskStatusBarItem: vscode.StatusBarItem;
  let statusBarsVisible = false;
  let previousCpuStatusText: string | undefined;
  let previousMemoryStatusText: string | undefined;
  let previousDiskStatusText: string | undefined;
  let latestCpuPercent = 0;
  let latestMemoryPercent = 0;
  let latestMemoryUsedBytes = 0;
  let latestMemoryTotalBytes = 0;
  let cpuHistory: number[] = [];
  let previousCpuWarning = false;
  let previousMemoryWarning = false;
  let previousDiskWarning = false;
  let diskTargetPath = '';
  let enabledMonitors: EnabledMonitors = { cpu: true, memory: true, disk: true };
  let currentAlignment: vscode.StatusBarAlignment | undefined;

  function disposeItems(): void {
    cpuStatusBarItem?.dispose();
    memoryStatusBarItem?.dispose();
    diskStatusBarItem?.dispose();
  }

  return {
    get cpuStatusBarItem() {
      return cpuStatusBarItem;
    },
    get memoryStatusBarItem() {
      return memoryStatusBarItem;
    },
    get diskStatusBarItem() {
      return diskStatusBarItem;
    },

    createItems() {
      const nextAlignment = readAlignment();

      if (currentAlignment === nextAlignment) {
        return;
      }

      disposeItems();
      currentAlignment = nextAlignment;
      cpuStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? CPU_STATUS_PRIORITY : CPU_STATUS_PRIORITY_LEFT);
      memoryStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? MEMORY_STATUS_PRIORITY : MEMORY_STATUS_PRIORITY_LEFT);
      diskStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? DISK_STATUS_PRIORITY : DISK_STATUS_PRIORITY_LEFT);
      statusBarsVisible = false;
    },

    update(sample: ResourceSample) {
      const thresholds = readWarningThresholds();
      const cpuWarning = enabledMonitors.cpu && sample.cpuPercent !== undefined ? sample.cpuPercent >= thresholds.cpuPercent : false;
      const memoryWarning = enabledMonitors.memory && sample.memoryPercent !== undefined ? sample.memoryPercent >= thresholds.memoryPercent : false;
      const diskWarning = sample.disk ? sample.disk.diskPercent >= thresholds.diskPercent : false;

      if (enabledMonitors.cpu && sample.cpuPercent !== undefined) {
        latestCpuPercent = sample.cpuPercent;
        const cpuTrendGraphConfig = readCpuTrendGraphConfig();
        let cpuTrendGraph = '';

        if (cpuTrendGraphConfig.enabled) {
          cpuHistory = [...cpuHistory, sample.cpuPercent].slice(-cpuTrendGraphConfig.length);
          cpuTrendGraph = ` ${formatCpuTrendGraph(cpuHistory, cpuTrendGraphConfig.length)}`;
        } else if (cpuHistory.length > 0) {
          cpuHistory = [];
        }

        const cpuStatusText = `$(chip) ${formatPercent(sample.cpuPercent)}${cpuTrendGraph}`;

        if (cpuStatusText !== previousCpuStatusText) {
          cpuStatusBarItem.text = cpuStatusText;
          previousCpuStatusText = cpuStatusText;
        }

        cpuStatusBarItem.command = SHOW_CPU_PROCESSES_COMMAND;
      }

      if (enabledMonitors.memory && sample.memoryPercent !== undefined && sample.memoryUsedBytes !== undefined && sample.memoryTotalBytes !== undefined) {
        latestMemoryPercent = sample.memoryPercent;
        latestMemoryUsedBytes = sample.memoryUsedBytes;
        latestMemoryTotalBytes = sample.memoryTotalBytes;
        const memoryStatusText = `$(server) ${formatStorageUsage(sample.memoryUsedBytes, sample.memoryTotalBytes)}`;

        if (memoryStatusText !== previousMemoryStatusText) {
          memoryStatusBarItem.text = memoryStatusText;
          previousMemoryStatusText = memoryStatusText;
        }

        memoryStatusBarItem.command = SHOW_MEMORY_PROCESSES_COMMAND;
      }

      const diskStatusText = enabledMonitors.disk && sample.disk ? `$(archive) ${formatDiskUsage(sample.disk)}` : '$(archive) --';
      const cpuBackgroundColor = cpuWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      const memoryBackgroundColor = memoryWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      const diskBackgroundColor = diskWarning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

      if (enabledMonitors.disk && diskStatusText !== previousDiskStatusText) {
        diskStatusBarItem.text = diskStatusText;
        previousDiskStatusText = diskStatusText;
        this.updateDiskTooltip(sample.disk);
      }

      if (cpuWarning !== previousCpuWarning) {
        cpuStatusBarItem.backgroundColor = cpuBackgroundColor;
        previousCpuWarning = cpuWarning;
      }

      if (memoryWarning !== previousMemoryWarning) {
        memoryStatusBarItem.backgroundColor = memoryBackgroundColor;
        previousMemoryWarning = memoryWarning;
      }

      if (diskWarning !== previousDiskWarning) {
        diskStatusBarItem.backgroundColor = diskBackgroundColor;
        previousDiskWarning = diskWarning;
      }

      if (!statusBarsVisible) {
        if (enabledMonitors.cpu) {
          cpuStatusBarItem.show();
        }
        if (enabledMonitors.memory) {
          memoryStatusBarItem.show();
        }
        if (enabledMonitors.disk) {
          diskStatusBarItem.show();
        }
        statusBarsVisible = true;
      }
    },

    updateCpuTooltip() {
      const thresholds = readWarningThresholds();
      cpuStatusBarItem.tooltip = new vscode.MarkdownString([
        '**CPU**',
        '',
        `Warning threshold: ${formatPercent(thresholds.cpuPercent)}`,
      ].join('\n\n'));
    },

    updateMemoryTooltip() {
      const thresholds = readWarningThresholds();
      const memoryTotalBytes = os.totalmem();
      const memoryUsedBytes = memoryTotalBytes - os.freemem();

      memoryStatusBarItem.tooltip = new vscode.MarkdownString(
        [
          '**Memory**',
          '',
          `Usage: ${formatPercent(calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes))}`,
          `Warning threshold: ${formatPercent(thresholds.memoryPercent)}`,
        ].join('\n\n'),
      );
    },

    updateDiskTooltip(disk?: DiskSample) {
      const thresholds = readWarningThresholds();
      diskStatusBarItem.tooltip = new vscode.MarkdownString(
        [
          '**Disk**',
          '',
          `Disk target: ${diskTargetPath}`,
          disk ? `Usage: ${formatStorageUsage(disk.diskUsedBytes, disk.diskTotalBytes)}` : 'Usage: --',
          `Warning threshold: ${formatPercent(thresholds.diskPercent)}`,
        ].join('\n\n'),
      );
    },

    setEnabledMonitors(nextEnabledMonitors: EnabledMonitors) {
      enabledMonitors = nextEnabledMonitors;

      if (!enabledMonitors.cpu) {
        cpuStatusBarItem.hide();
        cpuStatusBarItem.backgroundColor = undefined;
        previousCpuStatusText = undefined;
        latestCpuPercent = 0;
        cpuHistory = [];
        previousCpuWarning = false;
      }

      if (!enabledMonitors.memory) {
        memoryStatusBarItem.hide();
        memoryStatusBarItem.backgroundColor = undefined;
        previousMemoryStatusText = undefined;
        latestMemoryPercent = 0;
        latestMemoryUsedBytes = 0;
        latestMemoryTotalBytes = 0;
        previousMemoryWarning = false;
      }

      if (!enabledMonitors.disk) {
        diskStatusBarItem.hide();
        diskStatusBarItem.backgroundColor = undefined;
        previousDiskStatusText = undefined;
        previousDiskWarning = false;
      }

      statusBarsVisible = false;
    },

    setDiskTargetPath(path: string) {
      diskTargetPath = path;
    },

    reset() {
      previousCpuStatusText = undefined;
      previousMemoryStatusText = undefined;
      previousDiskStatusText = undefined;
      latestCpuPercent = 0;
      latestMemoryPercent = 0;
      latestMemoryUsedBytes = 0;
      latestMemoryTotalBytes = 0;
      cpuHistory = [];
      previousCpuWarning = false;
      previousMemoryWarning = false;
      previousDiskWarning = false;
      cpuStatusBarItem.backgroundColor = undefined;
      memoryStatusBarItem.backgroundColor = undefined;
      diskStatusBarItem.backgroundColor = undefined;
      statusBarsVisible = false;
    },

    getLatestMetrics() {
      return {
        cpuPercent: latestCpuPercent,
        memoryPercent: latestMemoryPercent,
        memoryUsedBytes: latestMemoryUsedBytes,
      };
    },

    show() {
      if (enabledMonitors.cpu) {
        cpuStatusBarItem.show();
      }
      if (enabledMonitors.memory) {
        memoryStatusBarItem.show();
      }
      if (enabledMonitors.disk) {
        diskStatusBarItem.show();
      }
      statusBarsVisible = true;
    },

    hide() {
      cpuStatusBarItem.hide();
      memoryStatusBarItem.hide();
      diskStatusBarItem.hide();
      statusBarsVisible = false;
    },

    dispose() {
      disposeItems();
    },
  };
}
