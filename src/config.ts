import * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  DEFAULT_CPU_WARNING_THRESHOLD_PERCENT,
  DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT,
  DEFAULT_DISK_WARNING_THRESHOLD_PERCENT,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
} from './constants.js';
import type { WarningThresholds } from './types.js';
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

export function isExtensionEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>('enabled', true);
}
