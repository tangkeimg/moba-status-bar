import * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  DEFAULT_CPU_MONITOR_ENABLED,
  DEFAULT_CPU_WARNING_THRESHOLD_PERCENT,
  DEFAULT_DISK_MONITOR_ENABLED,
  DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT,
  DEFAULT_DISK_WARNING_THRESHOLD_PERCENT,
  DEFAULT_CPU_TREND_GRAPH_LENGTH,
  DEFAULT_SHOW_CPU_TREND_GRAPH,
  MAX_CPU_TREND_GRAPH_LENGTH,
  DEFAULT_MEMORY_MONITOR_ENABLED,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_CPU_TREND_GRAPH_LENGTH,
  MIN_REFRESH_INTERVAL_MS,
} from './constants.js';
import type { CpuTrendGraphConfig, EnabledMonitors, WarningThresholds } from './types.js';
import { clampPercent } from './utils.js';

export function readWarningThresholds(): WarningThresholds {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const cpuPercent = config.get<number>('cpuWarningThresholdPercent', DEFAULT_CPU_WARNING_THRESHOLD_PERCENT);
  const memoryPercent = config.get<number>('memoryWarningThresholdPercent', DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT);
  const diskPercent = config.get<number>('diskWarningThresholdPercent', DEFAULT_DISK_WARNING_THRESHOLD_PERCENT);

  return {
    cpuPercent: clampPercent(cpuPercent),
    memoryPercent: clampPercent(memoryPercent),
    diskPercent: clampPercent(diskPercent),
  };
}

export function readRefreshIntervalMs(): number {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  return Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);
}

export function readCpuTrendGraphConfig(): CpuTrendGraphConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = config.get<boolean>('showCpuTrendGraph', DEFAULT_SHOW_CPU_TREND_GRAPH);
  const length = config.get<number>('cpuTrendGraphLength', DEFAULT_CPU_TREND_GRAPH_LENGTH);

  return {
    enabled,
    length: Math.min(MAX_CPU_TREND_GRAPH_LENGTH, Math.max(MIN_CPU_TREND_GRAPH_LENGTH, Math.round(length))),
  };
}

export function readEnabledMonitors(): EnabledMonitors {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    cpu: config.get<boolean>('cpuEnabled', DEFAULT_CPU_MONITOR_ENABLED),
    memory: config.get<boolean>('memoryEnabled', DEFAULT_MEMORY_MONITOR_ENABLED),
    disk: config.get<boolean>('diskEnabled', DEFAULT_DISK_MONITOR_ENABLED),
  };
}

export function isExtensionEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>('enabled', true);
}
