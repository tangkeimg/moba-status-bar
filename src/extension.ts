import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import checkDiskSpace from 'check-disk-space';
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
  disk?: DiskSample;
};

type CpuProcess = {
  name: string;
  cpuPercent: number;
};

type DiskSample = {
  diskPath: string;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
};

type WarningThresholds = {
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
};

const CONFIG_SECTION = 'mobaStatusBar';
const DEFAULT_REFRESH_INTERVAL_MS = 1000;
const MIN_REFRESH_INTERVAL_MS = 500;
const DEFAULT_CPU_WARNING_THRESHOLD_PERCENT = 90;
const DEFAULT_MEMORY_WARNING_THRESHOLD_PERCENT = 90;
const DEFAULT_DISK_WARNING_THRESHOLD_PERCENT = 85;
const FIGURE_SPACE = '\u2007';
const SHOW_CPU_PROCESSES_COMMAND = 'mobaStatusBar.showCpuProcesses';
const TOP_CPU_PROCESS_COUNT = 5;
const RANK_LABELS = ['🔥', '    ', '    ', '    ', '    '];

const execFileAsync = promisify(execFile);

let cpuStatusBarItem: vscode.StatusBarItem | undefined;
let resourceStatusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let statusBarsVisible = false;
let previousCpuStatusText: string | undefined;
let previousResourceStatusText: string | undefined;
let latestCpuPercent = 0;
let previousCpuWarning = false;
let previousResourceWarningLevel: 'none' | 'warning' | 'error' = 'none';
let refreshInProgress = false;
let cpuProcessesCommandInProgress = false;

export function activate(context: vscode.ExtensionContext): void {
  cpuStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  resourceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  context.subscriptions.push(cpuStatusBarItem, resourceStatusBarItem);
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_CPU_PROCESSES_COMMAND, showTopCpuProcesses),
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
  cpuStatusBarItem?.dispose();
  resourceStatusBarItem?.dispose();
  cpuStatusBarItem = undefined;
  resourceStatusBarItem = undefined;
}

function applyConfiguration(): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = config.get<boolean>('enabled', true);

  stopRefreshing();

  if (!enabled) {
    cpuStatusBarItem?.hide();
    resourceStatusBarItem?.hide();
    statusBarsVisible = false;
    return;
  }

  previousCpuSnapshot = readCpuSnapshot();
  previousCpuStatusText = undefined;
  previousResourceStatusText = undefined;
  latestCpuPercent = 0;
  previousCpuWarning = false;
  previousResourceWarningLevel = 'none';
  updateCpuTooltip();
  updateResourceTooltip();
  void updateStatusBar();

  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  const refreshIntervalMs = Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);

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
  if (!cpuStatusBarItem || !resourceStatusBarItem) {
    return;
  }

  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;
  let sample: ResourceSample;

  try {
    sample = await readResourceSample();
  } finally {
    refreshInProgress = false;
  }

  if (!cpuStatusBarItem || !resourceStatusBarItem) {
    return;
  }

  const thresholds = readWarningThresholds();
  latestCpuPercent = sample.cpuPercent;
  const cpuWarning = sample.cpuPercent >= thresholds.cpuPercent;
  const memoryWarning = sample.memoryPercent >= thresholds.memoryPercent;
  const diskWarning = sample.disk ? sample.disk.diskPercent >= thresholds.diskPercent : false;
  const diskText = sample.disk
    ? `  $(archive) ${formatDiskUsage(sample.disk)}`
    : '  $(archive) --';
  const cpuStatusText = `$(chip) ${formatPercent(sample.cpuPercent)}`;
  const resourceStatusText = `$(server) ${formatStorageUsage(sample.memoryUsedBytes, sample.memoryTotalBytes)}${diskText}`;
  const cpuBackgroundColor = cpuWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  const resourceWarningLevel = memoryWarning ? 'error' : diskWarning ? 'warning' : 'none';
  const resourceBackgroundColor =
    memoryWarning
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : diskWarning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

  if (cpuStatusText !== previousCpuStatusText) {
    cpuStatusBarItem.text = cpuStatusText;
    previousCpuStatusText = cpuStatusText;
  }
  cpuStatusBarItem.command = SHOW_CPU_PROCESSES_COMMAND;

  if (resourceStatusText !== previousResourceStatusText) {
    resourceStatusBarItem.text = resourceStatusText;
    previousResourceStatusText = resourceStatusText;
  }

  if (cpuWarning !== previousCpuWarning) {
    cpuStatusBarItem.backgroundColor = cpuBackgroundColor;
    previousCpuWarning = cpuWarning;
  }

  if (resourceWarningLevel !== previousResourceWarningLevel) {
    resourceStatusBarItem.backgroundColor = resourceBackgroundColor;
    previousResourceWarningLevel = resourceWarningLevel;
  }

  if (!statusBarsVisible) {
    cpuStatusBarItem.show();
    resourceStatusBarItem.show();
    statusBarsVisible = true;
  }
}

function updateResourceTooltip(): void {
  if (!resourceStatusBarItem) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredInterval = config.get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS);
  const refreshIntervalMs = Math.max(MIN_REFRESH_INTERVAL_MS, configuredInterval);
  const thresholds = readWarningThresholds();
  const memoryTotalBytes = os.totalmem();
  const memoryUsedBytes = memoryTotalBytes - os.freemem();
  const diskTargetPath = getDiskTargetPath();

  resourceStatusBarItem.tooltip = new vscode.MarkdownString(
    [
      '**Moba Status Bar**',
      '',
      `Memory: ${formatStorageUsage(memoryUsedBytes, memoryTotalBytes)}`,
      `Disk target: ${diskTargetPath}`,
      'Disk usage is shown as disk name plus used percentage.',
      `CPU warning threshold: ${formatPercent(thresholds.cpuPercent)}`,
      `Memory warning threshold: ${formatPercent(thresholds.memoryPercent)}`,
      `Disk warning threshold: ${formatPercent(thresholds.diskPercent)}`,
      `Platform: ${os.platform()} ${os.arch()}`,
      `Refresh interval: ${refreshIntervalMs} ms`,
    ].join('\n\n'),
  );
}

function updateCpuTooltip(): void {
  if (!cpuStatusBarItem) {
    return;
  }

  cpuStatusBarItem.tooltip = new vscode.MarkdownString([
    '**CPU**',
    '',
    'Click to collect and show the top CPU processes.',
  ].join('\n\n'));
}

async function showTopCpuProcesses(): Promise<void> {
  if (cpuProcessesCommandInProgress) {
    return;
  }

  cpuProcessesCommandInProgress = true;

  try {
    const topCpuProcesses = await readTopCpuProcesses();
    await showCpuProcessesQuickPick(topCpuProcesses);
  } finally {
    cpuProcessesCommandInProgress = false;
  }
}

async function showCpuProcessesQuickPick(topCpuProcesses: CpuProcess[]): Promise<void> {
  const items =
    topCpuProcesses.length > 0
      ? normalizeTopProcessCpuPercents(topCpuProcesses, latestCpuPercent).map((process, index) => ({
          label: `${RANK_LABELS[index] ?? `${index + 1}.`} ${formatProcessName(process.name)}`,
          description: formatProcessCpuPercent(process.cpuPercent),
        }))
      : [{ label: 'No process data available' }];

  await vscode.window.showQuickPick(items, {
    title: `Top ${TOP_CPU_PROCESS_COUNT} CPU Processes - CPU ${formatPercent(latestCpuPercent)}`,
    placeHolder: 'Collected when this list opens.',
  });
}

async function readResourceSample(): Promise<ResourceSample> {
  const cpuSnapshot = readCpuSnapshot();
  const cpuPercent = previousCpuSnapshot ? calculateCpuPercent(previousCpuSnapshot, cpuSnapshot) : 0;
  previousCpuSnapshot = cpuSnapshot;

  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();
  const memoryUsedBytes = memoryTotalBytes - memoryFreeBytes;
  const memoryPercent = memoryTotalBytes > 0 ? (memoryUsedBytes / memoryTotalBytes) * 100 : 0;
  const disk = await readDiskSample();

  return {
    cpuPercent,
    memoryPercent,
    memoryUsedBytes,
    memoryTotalBytes,
    disk,
  };
}

async function readDiskSample(): Promise<DiskSample | undefined> {
  try {
    const diskSpace = await checkDiskSpace(getDiskTargetPath());
    const diskTotalBytes = diskSpace.size;
    const diskUsedBytes = diskSpace.size - diskSpace.free;
    const diskPercent = diskTotalBytes > 0 ? (diskUsedBytes / diskTotalBytes) * 100 : 0;

    return {
      diskPath: diskSpace.diskPath,
      diskPercent,
      diskUsedBytes,
      diskTotalBytes,
    };
  } catch {
    return undefined;
  }
}

function getDiskTargetPath(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder?.uri.fsPath ?? os.homedir();
}

async function readTopCpuProcesses(): Promise<CpuProcess[]> {
  if (process.platform === 'win32') {
    return readWindowsTopCpuProcesses();
  }

  return readUnixTopCpuProcesses();
}

async function readWindowsTopCpuProcesses(): Promise<CpuProcess[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process',
          "Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' }",
          'Sort-Object PercentProcessorTime -Descending',
          `Select-Object -First ${TOP_CPU_PROCESS_COUNT} Name,IDProcess,PercentProcessorTime`,
          'ConvertTo-Json -Compress',
        ].join(' | '),
      ],
      { timeout: 1200, windowsHide: true },
    );

    const parsed = JSON.parse(stdout.trim()) as
      | { Name?: unknown; IDProcess?: unknown; PercentProcessorTime?: unknown }
      | Array<{ Name?: unknown; IDProcess?: unknown; PercentProcessorTime?: unknown }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    return rows
      .map((row) => ({
        name: formatWindowsProcessName(row),
        cpuPercent: typeof row.PercentProcessorTime === 'number' ? row.PercentProcessorTime : 0,
      }))
      .filter((row) => row.cpuPercent > 0);
  } catch {
    return [];
  }
}

async function readUnixTopCpuProcesses(): Promise<CpuProcess[]> {
  try {
    const args =
      process.platform === 'linux'
        ? ['-ww', '-eo', 'args,pcpu', '--sort=-pcpu']
        : ['-ww', '-Ao', 'args,pcpu'];
    const { stdout } = await execFileAsync('ps', args, {
      timeout: 1200,
      windowsHide: true,
    });

    return parsePsProcessRows(stdout);
  } catch {
    return [];
  }
}

function parsePsProcessRows(stdout: string): CpuProcess[] {
  const processRows = stdout
    .trim()
    .split('\n')
    .slice(1)
    .map(parseUnixProcessRow)
    .filter((processRow): processRow is CpuProcess => Boolean(processRow))
    .filter((processRow) => processRow.cpuPercent > 0);

  return processRows
    .filter((processRow) => !isSamplerProcess(processRow.name))
    .sort((left, right) => right.cpuPercent - left.cpuPercent)
    .slice(0, TOP_CPU_PROCESS_COUNT);
}

function parseUnixProcessRow(row: string): CpuProcess | undefined {
  const match = row.trim().match(/^(.*\S)\s+([0-9]+(?:\.[0-9]+)?)$/);

  if (!match) {
    return undefined;
  }

  return {
    name: match[1],
    cpuPercent: Number(match[2]),
  };
}

function formatWindowsProcessName(row: {
  Name?: unknown;
  IDProcess?: unknown;
  PercentProcessorTime?: unknown;
}): string {
  const name = typeof row.Name === 'string' ? row.Name : 'Unknown';
  const pid = typeof row.IDProcess === 'number' ? row.IDProcess : undefined;

  return pid ? `${name} (${pid})` : name;
}

function formatProcessName(name: string): string {
  const normalizedName = name.trim().replace(/\s+/g, ' ');
  const maxLength = 90;

  if (normalizedName.length <= maxLength) {
    return normalizedName;
  }

  return `${normalizedName.slice(0, maxLength - 1)}...`;
}

function isSamplerProcess(name: string): boolean {
  const normalizedName = name.trim().toLowerCase();

  return (
    normalizedName === 'ps' ||
    normalizedName.startsWith('ps ') ||
    normalizedName.includes(' pcpu') ||
    normalizedName === 'powershell.exe' ||
    normalizedName === 'powershell' ||
    normalizedName.includes('win32_perfformatteddata_perfproc_process') ||
    normalizedName.includes('get-ciminstance')
  );
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
  const diskPercent = config.get<number>(
    'diskWarningThresholdPercent',
    DEFAULT_DISK_WARNING_THRESHOLD_PERCENT,
  );

  return {
    cpuPercent: clampPercent(cpuPercent),
    memoryPercent: clampPercent(memoryPercent),
    diskPercent: clampPercent(diskPercent),
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

function normalizeTopProcessCpuPercents(processes: CpuProcess[], totalCpuPercent: number): CpuProcess[] {
  const processTotal = processes.reduce((total, process) => total + Math.max(0, process.cpuPercent), 0);

  if (processTotal <= 0 || totalCpuPercent <= 0) {
    return processes.map((process) => ({ ...process, cpuPercent: 0 }));
  }

  return processes.map((process) => ({
    ...process,
    cpuPercent: (Math.max(0, process.cpuPercent) / processTotal) * clampPercent(totalCpuPercent),
  }));
}

function formatProcessCpuPercent(value: number): string {
  return `${clampPercent(value).toFixed(1)}%`;
}

function formatStorageUsage(usedBytes: number, totalBytes: number): string {
  return `${formatGigabytes(usedBytes)}GB / ${formatGigabytes(totalBytes)}GB`;
}

function formatDiskUsage(disk: DiskSample): string {
  return `${formatDiskLabel(disk.diskPath)} ${formatPercent(disk.diskPercent)}`;
}

function formatDiskLabel(diskPath: string): string {
  if (/^[A-Za-z]:/.test(diskPath)) {
    return diskPath.slice(0, 2).toUpperCase();
  }

  return diskPath || '/';
}

function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
