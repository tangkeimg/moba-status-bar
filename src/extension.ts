import * as os from 'node:os';
import * as vscode from 'vscode';

type CpuSnapshot = {
  idle: number;
  total: number;
};

type ResourceSample = {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
};

type WarningThresholds = {
  cpuPercent: number;
  memoryPercent: number;
};

const CONFIG_SECTION = 'mobaStatusBar';
const DEFAULT_REFRESH_INTERVAL_MS = 1000;
const MIN_REFRESH_INTERVAL_MS = 500;
const DEFAULT_CPU_WARNING_THRESHOLD_PERCENT = 80;
const DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT = 90;
const FIGURE_SPACE = '\u2007';

let statusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let statusBarVisible = false;
let previousStatusText: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);

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
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

function applyConfiguration(): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = config.get<boolean>('enabled', true);

  stopRefreshing();

  if (!enabled) {
    statusBarItem?.hide();
    statusBarVisible = false;
    return;
  }

  previousCpuSnapshot = readCpuSnapshot();
  previousStatusText = undefined;
  updateTooltip();
  updateStatusBar();

  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  const refreshIntervalMs = Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);

  refreshTimer = setInterval(updateStatusBar, refreshIntervalMs);
}

function stopRefreshing(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  const sample = readResourceSample();
  const thresholds = readWarningThresholds();
  const cpuWarning = sample.cpuPercent >= thresholds.cpuPercent;
  const memoryWarning = sample.memoryPercent >= thresholds.memoryPercent;
  const statusText = `$(chip) ${formatPercent(sample.cpuPercent)}  $(server) ${formatMemoryUsage(sample.memoryUsedBytes, sample.memoryTotalBytes)}`;
  const statusBackgroundColor =
    cpuWarning || memoryWarning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  if (statusText !== previousStatusText) {
    statusBarItem.text = statusText;
    previousStatusText = statusText;
  }

  statusBarItem.backgroundColor = statusBackgroundColor;

  if (!statusBarVisible) {
    statusBarItem.show();
    statusBarVisible = true;
  }
}

function updateTooltip(): void {
  if (!statusBarItem) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  const refreshIntervalMs = Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);
  const thresholds = readWarningThresholds();
  const memoryTotalBytes = os.totalmem();
  const memoryUsedBytes = memoryTotalBytes - os.freemem();

  statusBarItem.tooltip = new vscode.MarkdownString(
    [
      '**Moba Status Bar**',
      '',
      `Memory: ${formatMemoryUsage(memoryUsedBytes, memoryTotalBytes)}`,
      `CPU warning threshold: ${formatPercent(thresholds.cpuPercent)}`,
      `Memory warning threshold: ${formatPercent(thresholds.memoryPercent)}`,
      `Platform: ${os.platform()} ${os.arch()}`,
      `Refresh interval: ${refreshIntervalMs} ms`,
    ].join('\n\n'),
  );
}

function readResourceSample(): ResourceSample {
  const cpuSnapshot = readCpuSnapshot();
  const cpuPercent = previousCpuSnapshot ? calculateCpuPercent(previousCpuSnapshot, cpuSnapshot) : 0;
  previousCpuSnapshot = cpuSnapshot;

  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();
  const memoryUsedBytes = memoryTotalBytes - memoryFreeBytes;
  const memoryPercent = memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0;

  return {
    cpuPercent,
    memoryPercent,
    memoryUsedBytes,
    memoryTotalBytes,
  };
}

function readWarningThresholds(): WarningThresholds {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const cpuPercent = config.get<number>(
    'cpuWarningThresholdPercent',
    DEFAULT_CPU_WARNING_THRESHOLD_PERCENT,
  );
  const memoryPercent = config.get<number>(
    'memoryWarningThresholdPercent',
    DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT,
  );

  return {
    cpuPercent: clampPercent(cpuPercent),
    memoryPercent: clampPercent(memoryPercent),
  };
}

function readCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce<CpuSnapshot>(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0);

      return {
        idle: snapshot.idle + cpu.times.idle,
        total: snapshot.total + total,
      };
    },
    { idle: 0, total: 0 },
  );
}

function calculateCpuPercent(previous: CpuSnapshot, current: CpuSnapshot): number {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0) {
    return 0;
  }

  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value)).toString().padStart(2, FIGURE_SPACE)}%`;
}

function formatMemoryUsage(usedBytes: number, totalBytes: number): string {
  return `${formatGigabytes(usedBytes)}GB / ${formatGigabytes(totalBytes)}GB`;
}

function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
