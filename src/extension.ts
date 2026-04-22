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

type MemoryProcess = {
  name: string;
  memoryPercent: number;
  memoryBytes: number;
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
const SHOW_MEMORY_PROCESSES_COMMAND = 'mobaStatusBar.showMemoryProcesses';
const TOP_CPU_PROCESS_COUNT = 5;
const TOP_MEMORY_PROCESS_COUNT = 5;
const RANK_LABELS = ['🔥', '    ', '    ', '    ', '    '];

const execFileAsync = promisify(execFile);

let cpuStatusBarItem: vscode.StatusBarItem | undefined;
let memoryStatusBarItem: vscode.StatusBarItem | undefined;
let diskStatusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let previousCpuSnapshot: CpuSnapshot | undefined;
let statusBarsVisible = false;
let previousCpuStatusText: string | undefined;
let previousMemoryStatusText: string | undefined;
let previousDiskStatusText: string | undefined;
let latestCpuPercent = 0;
let latestMemoryPercent = 0;
let latestMemoryUsedBytes = 0;
let latestMemoryTotalBytes = 0;
let previousCpuWarning = false;
let previousMemoryWarning = false;
let previousDiskWarning = false;
let refreshInProgress = false;
let cpuProcessesCommandInProgress = false;
let memoryProcessesCommandInProgress = false;

export function activate(context: vscode.ExtensionContext): void {
  cpuStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  memoryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  diskStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(cpuStatusBarItem, memoryStatusBarItem, diskStatusBarItem);
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_CPU_PROCESSES_COMMAND, showTopCpuProcesses),
    vscode.commands.registerCommand(SHOW_MEMORY_PROCESSES_COMMAND, showTopMemoryProcesses),
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
  memoryStatusBarItem?.dispose();
  diskStatusBarItem?.dispose();
  cpuStatusBarItem = undefined;
  memoryStatusBarItem = undefined;
  diskStatusBarItem = undefined;
}

function applyConfiguration(): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = config.get<boolean>('enabled', true);

  stopRefreshing();

  if (!enabled) {
    cpuStatusBarItem?.hide();
    memoryStatusBarItem?.hide();
    diskStatusBarItem?.hide();
    statusBarsVisible = false;
    return;
  }

  previousCpuSnapshot = readCpuSnapshot();
  previousCpuStatusText = undefined;
  previousMemoryStatusText = undefined;
  previousDiskStatusText = undefined;
  latestCpuPercent = 0;
  latestMemoryPercent = 0;
  latestMemoryUsedBytes = 0;
  latestMemoryTotalBytes = 0;
  previousCpuWarning = false;
  previousMemoryWarning = false;
  previousDiskWarning = false;
  updateCpuTooltip();
  updateMemoryTooltip();
  updateDiskTooltip();
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
  if (!cpuStatusBarItem || !memoryStatusBarItem || !diskStatusBarItem) {
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

  if (!cpuStatusBarItem || !memoryStatusBarItem || !diskStatusBarItem) {
    return;
  }

  const thresholds = readWarningThresholds();
  latestCpuPercent = sample.cpuPercent;
  latestMemoryPercent = sample.memoryPercent;
  latestMemoryUsedBytes = sample.memoryUsedBytes;
  latestMemoryTotalBytes = sample.memoryTotalBytes;
  const cpuWarning = sample.cpuPercent >= thresholds.cpuPercent;
  const memoryWarning = sample.memoryPercent >= thresholds.memoryPercent;
  const diskWarning = sample.disk ? sample.disk.diskPercent >= thresholds.diskPercent : false;
  const cpuStatusText = `$(chip) ${formatPercent(sample.cpuPercent)}`;
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
}

function updateMemoryTooltip(): void {
  if (!memoryStatusBarItem) {
    return;
  }

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
}

function updateDiskTooltip(): void {
  if (!diskStatusBarItem) {
    return;
  }

  const thresholds = readWarningThresholds();
  const diskTargetPath = getDiskTargetPath();

  diskStatusBarItem.tooltip = new vscode.MarkdownString(
    [
      '**Disk**',
      '',
      `Disk target: ${diskTargetPath}`,
      'Disk usage is shown as disk name plus used percentage.',
      `Disk warning threshold: ${formatPercent(thresholds.diskPercent)}`,
      `Platform: ${os.platform()} ${os.arch()}`,
    ].join('\n\n'),
  );
}

function updateCpuTooltip(): void {
  if (!cpuStatusBarItem) {
    return;
  }

  const thresholds = readWarningThresholds();

  cpuStatusBarItem.tooltip = new vscode.MarkdownString([
    '**CPU**',
    '',
    `Warning threshold: ${formatPercent(thresholds.cpuPercent)}`,
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

async function showTopMemoryProcesses(): Promise<void> {
  if (memoryProcessesCommandInProgress) {
    return;
  }

  memoryProcessesCommandInProgress = true;

  try {
    const topMemoryProcesses = await readTopMemoryProcesses();
    await showMemoryProcessesQuickPick(topMemoryProcesses);
  } finally {
    memoryProcessesCommandInProgress = false;
  }
}

async function showMemoryProcessesQuickPick(topMemoryProcesses: MemoryProcess[]): Promise<void> {
  const items =
    topMemoryProcesses.length > 0
      ? topMemoryProcesses.map((process, index) => ({
          label: `${RANK_LABELS[index] ?? `${index + 1}.`} ${formatProcessName(process.name)}`,
          description: `${formatBytes(process.memoryBytes)} · ${formatProcessCpuPercent(process.memoryPercent)}`,
        }))
      : [{ label: 'No process data available' }];

  await vscode.window.showQuickPick(items, {
    title: `Top ${TOP_MEMORY_PROCESS_COUNT} Memory Processes - Memory ${formatBytes(latestMemoryUsedBytes)} · ${formatPercent(latestMemoryPercent)}`,
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
  const memoryPercent = calculateMemoryPercent(memoryUsedBytes, memoryTotalBytes);
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

async function readTopMemoryProcesses(): Promise<MemoryProcess[]> {
  if (process.platform === 'win32') {
    return readWindowsTopMemoryProcesses();
  }

  return readUnixTopMemoryProcesses();
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

async function readWindowsTopMemoryProcesses(): Promise<MemoryProcess[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          'Get-CimInstance Win32_Process',
          'Sort-Object WorkingSetSize -Descending',
          `Select-Object -First ${TOP_MEMORY_PROCESS_COUNT} Name,ProcessId,WorkingSetSize`,
          'ConvertTo-Json -Compress',
        ].join(' | '),
      ],
      { timeout: 1200, windowsHide: true },
    );

    const parsed = JSON.parse(stdout.trim()) as
      | { Name?: unknown; ProcessId?: unknown; WorkingSetSize?: unknown }
      | Array<{ Name?: unknown; ProcessId?: unknown; WorkingSetSize?: unknown }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const totalMemoryBytes = os.totalmem();

    return rows
      .map((row) => ({
        name: formatWindowsMemoryProcessName(row),
        memoryBytes: typeof row.WorkingSetSize === 'number' ? row.WorkingSetSize : 0,
        memoryPercent:
          typeof row.WorkingSetSize === 'number' && totalMemoryBytes > 0
            ? (row.WorkingSetSize / totalMemoryBytes) * 100
            : 0,
      }))
      .filter((row) => row.memoryPercent > 0);
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

async function readUnixTopMemoryProcesses(): Promise<MemoryProcess[]> {
  try {
    const args =
      process.platform === 'linux'
        ? ['-ww', '-eo', 'args,pmem', '--sort=-pmem']
        : ['-ww', '-Ao', 'args,pmem'];
    const { stdout } = await execFileAsync('ps', args, {
      timeout: 1200,
      windowsHide: true,
    });

    return parsePsMemoryRows(stdout);
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

function parsePsMemoryRows(stdout: string): MemoryProcess[] {
  const processRows = stdout
    .trim()
    .split('\n')
    .slice(1)
    .map(parseUnixMemoryProcessRow)
    .filter((processRow): processRow is MemoryProcess => Boolean(processRow))
    .filter((processRow) => processRow.memoryPercent > 0);

  return processRows
    .filter((processRow) => !isSamplerProcess(processRow.name))
    .sort((left, right) => right.memoryPercent - left.memoryPercent)
    .slice(0, TOP_MEMORY_PROCESS_COUNT);
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

function parseUnixMemoryProcessRow(row: string): MemoryProcess | undefined {
  const match = row.trim().match(/^(.*\S)\s+([0-9]+(?:\.[0-9]+)?)$/);

  if (!match) {
    return undefined;
  }

  const memoryPercent = Number(match[2]);

  return {
    name: match[1],
    memoryPercent,
    memoryBytes: (memoryPercent / 100) * os.totalmem(),
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

function formatWindowsMemoryProcessName(row: {
  Name?: unknown;
  ProcessId?: unknown;
  WorkingSetSize?: unknown;
}): string {
  const name = typeof row.Name === 'string' ? row.Name : 'Unknown';
  const pid = typeof row.ProcessId === 'number' ? row.ProcessId : undefined;

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

function calculateMemoryPercent(usedBytes: number, totalBytes: number): number {
  return totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${formatGigabytes(bytes)}GB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  }

  return `${Math.max(0, bytes).toFixed(0)}B`;
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
