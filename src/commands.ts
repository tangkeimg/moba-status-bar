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

      try {
        const topCpuProcesses = await readTopCpuProcesses();
        const { cpuPercent } = getLatestMetrics();
        const items =
          topCpuProcesses.length > 0
            ? normalizeTopProcessCpuPercents(topCpuProcesses, cpuPercent).map((process, index) => ({
                label: `${RANK_LABELS[index] ?? `${index + 1}.`} ${formatProcessName(process.name)}`,
                description: formatProcessCpuPercent(process.cpuPercent),
              }))
            : [{ label: 'No process data available' }];

        await vscode.window.showQuickPick(items, {
          title: `Top ${TOP_CPU_PROCESS_COUNT} CPU Processes - CPU ${formatPercent(cpuPercent)}`,
          placeHolder: 'Collected when this list opens.',
        });
      } finally {
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
