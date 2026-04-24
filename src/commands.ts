import * as vscode from 'vscode';
import { TOP_CPU_PROCESS_COUNT, TOP_MEMORY_PROCESS_COUNT, RANK_LABELS } from './constants.js';
import { readTopCpuProcesses, readTopMemoryProcesses } from './processes.js';
import type { CpuProcess, MemoryProcess } from './types.js';
import {
  formatPercent,
  formatBytes,
  formatProcessName,
  formatProcessCpuPercent,
  normalizeTopProcessCpuPercents,
} from './utils.js';

export interface CommandHandlers {
  showTopCpuProcesses(): Promise<void>;
  showTopMemoryProcesses(): Promise<void>;
}

export function createCommandHandlers(
  getLatestMetrics: () => { cpuPercent: number; memoryPercent: number; memoryUsedBytes: number },
): CommandHandlers {
  let cpuProcessesCommandInProgress = false;
  let memoryProcessesCommandInProgress = false;

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
  };
}
