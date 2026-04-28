import * as vscode from 'vscode';
import {
  CONFIG_SECTION,
  DEFAULT_CPU_MONITOR_ENABLED,
  DEFAULT_CPU_WARNING_THRESHOLD_PERCENT,
  DEFAULT_GPU_MONITOR_ENABLED,
  DEFAULT_GPU_WARNING_THRESHOLD_PERCENT,
  DEFAULT_DISK_MONITOR_ENABLED,
  DEFAULT_NETWORK_MONITOR_ENABLED,
  DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT,
  DEFAULT_DISK_WARNING_THRESHOLD_PERCENT,
  DEFAULT_CPU_TREND_GRAPH_LENGTH,
  DEFAULT_SHOW_CPU_TREND_GRAPH,
  DEFAULT_SHOW_NETWORK_UPLOAD,
  MAX_CPU_TREND_GRAPH_LENGTH,
  DEFAULT_MEMORY_MONITOR_ENABLED,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_ALIGNMENT,
  DEFAULT_GPU_SUMMARY_MODE,
  DEFAULT_WINDOWS_GPU_BACKEND,
  MAX_WARNING_THRESHOLD_PERCENT,
  MIN_CPU_TREND_GRAPH_LENGTH,
  MIN_REFRESH_INTERVAL_MS,
} from './constants.js';
import type { CpuTrendGraphConfig, EnabledMonitors, GpuDeviceCategory, GpuDisplayConfig, GpuSummaryMode, WarningThresholds, WindowsGpuBackend } from './types.js';

const GPU_SUMMARY_MODES: GpuSummaryMode[] = ['auto', 'discrete', 'integrated', 'selected'];
const GPU_CATEGORY_VALUES: GpuDeviceCategory[] = ['integrated', 'discrete', 'unknown'];
const WINDOWS_GPU_BACKENDS: WindowsGpuBackend[] = ['typeperf', 'powershell'];
const GPU_DISPLAY_CONFIG_STORAGE_KEY = 'gpuDisplayConfig';

let gpuDisplayConfigStorage: vscode.Memento | undefined;

export function initializeGpuDisplayConfigStorage(context: vscode.ExtensionContext): void {
  gpuDisplayConfigStorage = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? context.workspaceState
    : context.globalState;
}

export function readWarningThresholds(): WarningThresholds {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const cpuPercent = config.get<number>('cpuWarningThresholdPercent', DEFAULT_CPU_WARNING_THRESHOLD_PERCENT);
  const memoryPercent = config.get<number>('memoryWarningThresholdPercent', DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT);
  const gpuPercent = config.get<number>('gpuWarningThresholdPercent', DEFAULT_GPU_WARNING_THRESHOLD_PERCENT);
  const diskPercent = config.get<number>('diskWarningThresholdPercent', DEFAULT_DISK_WARNING_THRESHOLD_PERCENT);

  return {
    cpuPercent: clampWarningThresholdPercent(cpuPercent),
    memoryPercent: clampWarningThresholdPercent(memoryPercent),
    gpuPercent: clampWarningThresholdPercent(gpuPercent),
    diskPercent: clampWarningThresholdPercent(diskPercent),
  };
}

function clampWarningThresholdPercent(value: number): number {
  return Math.min(MAX_WARNING_THRESHOLD_PERCENT, Math.max(0, value));
}

export function readRefreshIntervalMs(): number {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  return Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);
}

export function readAlignment(): vscode.StatusBarAlignment {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const alignment = config.get<'left' | 'right'>('alignment', DEFAULT_ALIGNMENT);
  return alignment == 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
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

export function readShowNetworkUpload(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>('showNetworkUpload', DEFAULT_SHOW_NETWORK_UPLOAD);
}

export function readEnabledMonitors(): EnabledMonitors {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    cpu: config.get<boolean>('cpuEnabled', DEFAULT_CPU_MONITOR_ENABLED),
    memory: config.get<boolean>('memoryEnabled', DEFAULT_MEMORY_MONITOR_ENABLED),
    gpu: config.get<boolean>('gpuEnabled', DEFAULT_GPU_MONITOR_ENABLED),
    disk: config.get<boolean>('diskEnabled', DEFAULT_DISK_MONITOR_ENABLED),
    network: config.get<boolean>('networkEnabled', DEFAULT_NETWORK_MONITOR_ENABLED),
  };
}

export function readWindowsGpuBackend(): WindowsGpuBackend {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const backend = config.get<WindowsGpuBackend>('windowsGpuBackend', DEFAULT_WINDOWS_GPU_BACKEND);

  return WINDOWS_GPU_BACKENDS.find((item) => item === backend) ?? DEFAULT_WINDOWS_GPU_BACKEND;
}

export function isExtensionEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>('enabled', true);
}

export function readGpuDisplayConfig(): GpuDisplayConfig {
  const storedValue = gpuDisplayConfigStorage?.get<unknown>(GPU_DISPLAY_CONFIG_STORAGE_KEY);

  if (storedValue !== undefined) {
    return normalizeGpuDisplayConfig(storedValue);
  }

  return createDefaultGpuDisplayConfig();
}

export async function writeGpuDisplayConfig(displayConfig: GpuDisplayConfig): Promise<void> {
  if (!gpuDisplayConfigStorage) {
    return;
  }

  await gpuDisplayConfigStorage.update(GPU_DISPLAY_CONFIG_STORAGE_KEY, normalizeGpuDisplayConfig(displayConfig));
}

function createDefaultGpuDisplayConfig(): GpuDisplayConfig {
  return {
    summaryMode: DEFAULT_GPU_SUMMARY_MODE,
    selectedDeviceMatchers: [],
    categoryOverrides: {},
  };
}

function normalizeGpuDisplayConfig(value: unknown): GpuDisplayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createDefaultGpuDisplayConfig();
  }

  const raw = value as {
    summaryMode?: string;
    selectedDeviceMatchers?: unknown[];
    categoryOverrides?: Record<string, unknown>;
  };

  return {
    summaryMode: normalizeGpuSummaryMode(raw.summaryMode),
    selectedDeviceMatchers: normalizeGpuStringArray(raw.selectedDeviceMatchers),
    categoryOverrides: normalizeGpuCategoryOverrides(raw.categoryOverrides),
  };
}

function normalizeGpuSummaryMode(value: string | undefined): GpuSummaryMode {
  return GPU_SUMMARY_MODES.find((mode) => mode === value) ?? DEFAULT_GPU_SUMMARY_MODE;
}

function normalizeGpuStringArray(value: unknown[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGpuCategoryOverrides(value: Record<string, unknown> | undefined): Record<string, GpuDeviceCategory> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value)
    .map(([matcher, category]) => {
      if (typeof matcher !== 'string' || typeof category !== 'string') {
        return undefined;
      }

      const trimmedMatcher = matcher.trim();

      if (!trimmedMatcher) {
        return undefined;
      }

      const normalizedCategory = GPU_CATEGORY_VALUES.find((item) => item === category);

      if (!normalizedCategory) {
        return undefined;
      }

      return [trimmedMatcher, normalizedCategory] as const;
    })
    .filter((entry): entry is readonly [string, GpuDeviceCategory] => entry !== undefined);

  return Object.fromEntries(normalizedEntries);
}
