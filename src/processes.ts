import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { TOP_CPU_PROCESS_COUNT, TOP_MEMORY_PROCESS_COUNT } from './constants.js';
import type { CpuProcess, MemoryProcess } from './types.js';

const execFileAsync = promisify(execFile);

export async function readTopCpuProcesses(): Promise<CpuProcess[]> {
  if (process.platform === 'win32') {
    return readWindowsTopCpuProcesses();
  }

  return readUnixTopCpuProcesses();
}

export async function readTopMemoryProcesses(): Promise<MemoryProcess[]> {
  if (process.platform === 'win32') {
    return readWindowsTopMemoryProcesses();
  }

  return readUnixTopMemoryProcesses();
}

async function readWindowsTopCpuProcesses(): Promise<CpuProcess[]> {
  const perfCounterRows = await readWindowsPerfCounterTopCpuProcesses();

  if (perfCounterRows.length > 0) {
    return perfCounterRows;
  }

  return readWindowsSampledTopCpuProcesses();
}

async function readWindowsPerfCounterTopCpuProcesses(): Promise<CpuProcess[]> {
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

    return parseJsonRows<{ Name?: unknown; IDProcess?: unknown; PercentProcessorTime?: unknown }>(stdout)
      .map((row) => ({
        name: formatWindowsProcessName(row),
        cpuPercent: typeof row.PercentProcessorTime === 'number' ? row.PercentProcessorTime : 0,
      }))
      .filter((row) => row.cpuPercent > 0)
      .filter((row) => !isSamplerProcess(row.name))
      .sort((left, right) => right.cpuPercent - left.cpuPercent)
      .slice(0, TOP_CPU_PROCESS_COUNT);
  } catch {
    return [];
  }
}

async function readWindowsSampledTopCpuProcesses(): Promise<CpuProcess[]> {
  try {
    const sampleLimit = TOP_CPU_PROCESS_COUNT * 3;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          '$logicalCpuCount = [Math]::Max(1, [Environment]::ProcessorCount)',
          '$firstSample = @{}',
          'Get-Process | ForEach-Object { if ($null -ne $_.CPU) { $firstSample[$_.Id] = [pscustomobject]@{ Name = $_.ProcessName; CPU = [double]$_.CPU } } }',
          '$sampleStart = Get-Date',
          'Start-Sleep -Milliseconds 600',
          '$elapsedSeconds = [Math]::Max(0.001, ((Get-Date) - $sampleStart).TotalSeconds)',
          '$rows = Get-Process | ForEach-Object { $previous = $firstSample[$_.Id]; if ($null -ne $previous -and $null -ne $_.CPU) { $delta = [double]$_.CPU - [double]$previous.CPU; if ($delta -gt 0) { [pscustomobject]@{ Name = $_.ProcessName; IDProcess = $_.Id; PercentProcessorTime = (($delta / $elapsedSeconds / $logicalCpuCount) * 100) } } } }',
          `$rows | Sort-Object PercentProcessorTime -Descending | Select-Object -First ${sampleLimit} Name,IDProcess,PercentProcessorTime | ConvertTo-Json -Compress`,
        ].join('; '),
      ],
      { timeout: 6000, windowsHide: true },
    );

    return parseJsonRows<{ Name?: unknown; IDProcess?: unknown; PercentProcessorTime?: unknown }>(stdout)
      .map((row) => ({
        name: formatWindowsProcessName(row),
        cpuPercent: typeof row.PercentProcessorTime === 'number' ? row.PercentProcessorTime : 0,
      }))
      .filter((row) => row.cpuPercent > 0)
      .filter((row) => !isSamplerProcess(row.name))
      .sort((left, right) => right.cpuPercent - left.cpuPercent)
      .slice(0, TOP_CPU_PROCESS_COUNT);
  } catch {
    return [];
  }
}

function parseJsonRows<T>(stdout: string): T[] {
  const trimmedStdout = stdout.trim();

  if (!trimmedStdout) {
    return [];
  }

  const parsed = JSON.parse(trimmedStdout) as T | T[] | null;

  if (!parsed) {
    return [];
  }

  return Array.isArray(parsed) ? parsed : [parsed];
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
        ? ['-ww', '-eo', 'pid,args,pcpu', '--sort=-pcpu']
        : ['-ww', '-Ao', 'pid,args,pcpu'];
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
        ? ['-ww', '-eo', 'pid,args,pmem', '--sort=-pmem']
        : ['-ww', '-Ao', 'pid,args,pmem'];
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
  const match = row.trim().match(/^([0-9]+)\s+(.*\S)\s+([0-9]+(?:\.[0-9]+)?)$/);

  if (!match) {
    return undefined;
  }

  return {
    name: formatUnixProcessName(match[2], match[1]),
    cpuPercent: Number(match[3]),
  };
}

function parseUnixMemoryProcessRow(row: string): MemoryProcess | undefined {
  const match = row.trim().match(/^([0-9]+)\s+(.*\S)\s+([0-9]+(?:\.[0-9]+)?)$/);

  if (!match) {
    return undefined;
  }

  const memoryPercent = Number(match[3]);

  return {
    name: formatUnixProcessName(match[2], match[1]),
    memoryPercent,
    memoryBytes: (memoryPercent / 100) * os.totalmem(),
  };
}

function formatUnixProcessName(name: string, pid: string): string {
  return pid ? `${name} (${pid})` : name;
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

function isSamplerProcess(name: string): boolean {
  const normalizedName = name.trim().toLowerCase();

  return (
    normalizedName === 'ps' ||
    normalizedName.startsWith('ps ') ||
    normalizedName.includes(' pcpu') ||
    normalizedName === 'powershell.exe' ||
    normalizedName === 'powershell' ||
    normalizedName.startsWith('powershell ') ||
    normalizedName.startsWith('powershell(') ||
    normalizedName === 'pwsh.exe' ||
    normalizedName === 'pwsh' ||
    normalizedName.startsWith('pwsh ') ||
    normalizedName.startsWith('pwsh(') ||
    normalizedName.includes('win32_perfformatteddata_perfproc_process') ||
    normalizedName.includes('get-ciminstance')
  );
}
