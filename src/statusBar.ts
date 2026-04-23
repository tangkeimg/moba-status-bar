import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  CPU_STATUS_PRIORITY,
  MEMORY_STATUS_PRIORITY,
  DISK_STATUS_PRIORITY,
  SHOW_CPU_PROCESSES_COMMAND,
  SHOW_MEMORY_PROCESSES_COMMAND,
} from './constants.js';
import { readCpuTrendGraphConfig, readWarningThresholds } from './config.js';
import type { ResourceSample, DiskSample } from './types.js';
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
      cpuStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, CPU_STATUS_PRIORITY);
      memoryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, MEMORY_STATUS_PRIORITY);
      diskStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, DISK_STATUS_PRIORITY);
    },

    update(sample: ResourceSample) {
      const thresholds = readWarningThresholds();
      latestCpuPercent = sample.cpuPercent;
      latestMemoryPercent = sample.memoryPercent;
      latestMemoryUsedBytes = sample.memoryUsedBytes;
      latestMemoryTotalBytes = sample.memoryTotalBytes;
      const cpuWarning = sample.cpuPercent >= thresholds.cpuPercent;
      const memoryWarning = sample.memoryPercent >= thresholds.memoryPercent;
      const diskWarning = sample.disk ? sample.disk.diskPercent >= thresholds.diskPercent : false;
      const cpuTrendGraphConfig = readCpuTrendGraphConfig();
      let cpuTrendGraph = '';

      if (cpuTrendGraphConfig.enabled) {
        cpuHistory = [...cpuHistory, sample.cpuPercent].slice(-cpuTrendGraphConfig.length);
        cpuTrendGraph = ` ${formatCpuTrendGraph(cpuHistory, cpuTrendGraphConfig.length)}`;
      } else if (cpuHistory.length > 0) {
        cpuHistory = [];
      }

      const cpuStatusText = `$(chip) ${formatPercent(sample.cpuPercent)}${cpuTrendGraph}`;
      const memoryStatusText = `$(server) ${formatStorageUsage(sample.memoryUsedBytes, sample.memoryTotalBytes)}`;
      const diskStatusText = sample.disk ? `$(archive) ${formatDiskUsage(sample.disk)}` : '$(archive) --';
      const cpuBackgroundColor = cpuWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      const memoryBackgroundColor = memoryWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      const diskBackgroundColor = diskWarning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

      if (cpuStatusText !== previousCpuStatusText) {
        cpuStatusBarItem.text = cpuStatusText;
        previousCpuStatusText = cpuStatusText;
      }
      cpuStatusBarItem.command = SHOW_CPU_PROCESSES_COMMAND;

      if (memoryStatusText !== previousMemoryStatusText) {
        memoryStatusBarItem.text = memoryStatusText;
        previousMemoryStatusText = memoryStatusText;
      }
      memoryStatusBarItem.command = SHOW_MEMORY_PROCESSES_COMMAND;

      if (diskStatusText !== previousDiskStatusText) {
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
        cpuStatusBarItem.show();
        memoryStatusBarItem.show();
        diskStatusBarItem.show();
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
    },

    getLatestMetrics() {
      return {
        cpuPercent: latestCpuPercent,
        memoryPercent: latestMemoryPercent,
        memoryUsedBytes: latestMemoryUsedBytes,
      };
    },

    show() {
      cpuStatusBarItem.show();
      memoryStatusBarItem.show();
      diskStatusBarItem.show();
      statusBarsVisible = true;
    },

    hide() {
      cpuStatusBarItem.hide();
      memoryStatusBarItem.hide();
      diskStatusBarItem.hide();
      statusBarsVisible = false;
    },

    dispose() {
      cpuStatusBarItem.dispose();
      memoryStatusBarItem.dispose();
      diskStatusBarItem.dispose();
    },
  };
}
