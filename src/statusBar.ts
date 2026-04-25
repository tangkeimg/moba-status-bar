import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  CPU_STATUS_PRIORITY,
  MEMORY_STATUS_PRIORITY,
  GPU_STATUS_PRIORITY,
  DISK_STATUS_PRIORITY,
  NETWORK_STATUS_PRIORITY,
  CPU_STATUS_PRIORITY_LEFT,
  MEMORY_STATUS_PRIORITY_LEFT,
  GPU_STATUS_PRIORITY_LEFT,
  DISK_STATUS_PRIORITY_LEFT,
  NETWORK_STATUS_PRIORITY_LEFT,
  CONFIGURE_GPU_DISPLAY_COMMAND,
  SHOW_CPU_PROCESSES_COMMAND,
  SHOW_MEMORY_PROCESSES_COMMAND,
} from './constants.js';
import { readAlignment, readCpuTrendGraphConfig, readShowNetworkUpload, readWarningThresholds } from './config.js';
import type { ResourceSample, DiskSample, EnabledMonitors, GpuAggregateSample, GpuDeviceCategory, GpuDeviceSample, GpuSummarySample, NetworkSample } from './types.js';
import {
  formatPercent,
  formatPrecisePercent,
  formatStatusBarPrecisePercent,
  formatStorageUsage,
  formatCompactStorageUsage,
  formatDiskUsage,
  calculateMemoryPercent,
  formatCpuTrendGraph,
  formatBytes,
  formatTransferRate,
} from './utils.js';

export interface StatusBarManager {
  readonly cpuStatusBarItem: vscode.StatusBarItem;
  readonly memoryStatusBarItem: vscode.StatusBarItem;
  readonly gpuStatusBarItem: vscode.StatusBarItem;
  readonly diskStatusBarItem: vscode.StatusBarItem;
  readonly networkStatusBarItem: vscode.StatusBarItem;
  createItems(): void;
  update(sample: ResourceSample): void;
  updateCpuTooltip(): void;
  updateMemoryTooltip(): void;
  updateGpuTooltip(gpu?: GpuAggregateSample): void;
  updateDiskTooltip(disk?: DiskSample): void;
  setEnabledMonitors(enabledMonitors: EnabledMonitors): void;
  setDiskTargetPath(diskTargetPath: string): void;
  getLatestMetrics(): { cpuPercent: number; memoryPercent: number; memoryUsedBytes: number };
  reset(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

type StatusBarItemState = {
  text: vscode.StatusBarItem['text'];
  tooltip: vscode.StatusBarItem['tooltip'];
  command: vscode.StatusBarItem['command'];
  backgroundColor: vscode.StatusBarItem['backgroundColor'];
};

export function createStatusBarManager(): StatusBarManager {
  let cpuStatusBarItem: vscode.StatusBarItem;
  let memoryStatusBarItem: vscode.StatusBarItem;
  let gpuStatusBarItem: vscode.StatusBarItem;
  let diskStatusBarItem: vscode.StatusBarItem;
  let networkStatusBarItem: vscode.StatusBarItem;
  let statusBarsVisible = false;
  let previousCpuStatusText: string | undefined;
  let previousMemoryStatusText: string | undefined;
  let previousGpuStatusText: string | undefined;
  let previousDiskStatusText: string | undefined;
  let previousNetworkStatusText: string | undefined;
  let previousGpuTooltipText: string | undefined;
  let latestCpuPercent = 0;
  let latestMemoryPercent = 0;
  let latestMemoryUsedBytes = 0;
  let latestMemoryTotalBytes = 0;
  let latestGpu: GpuAggregateSample | undefined;
  let cpuHistory: number[] = [];
  let previousCpuWarning = false;
  let previousMemoryWarning = false;
  let previousGpuWarning = false;
  let previousDiskWarning = false;
  let diskTargetPath = '';
  let enabledMonitors: EnabledMonitors = { cpu: true, memory: true, gpu: true, disk: true, network: false };
  let currentAlignment: vscode.StatusBarAlignment | undefined;

  function disposeItems(): void {
    cpuStatusBarItem?.dispose();
    memoryStatusBarItem?.dispose();
    gpuStatusBarItem?.dispose();
    diskStatusBarItem?.dispose();
    networkStatusBarItem?.dispose();
  }

  function captureItemState(item: vscode.StatusBarItem): StatusBarItemState {
    return {
      text: item.text,
      tooltip: item.tooltip,
      command: item.command,
      backgroundColor: item.backgroundColor,
    };
  }

  function restoreItemState(item: vscode.StatusBarItem, state: StatusBarItemState | undefined): void {
    if (!state) {
      return;
    }

    item.text = state.text;
    item.tooltip = state.tooltip;
    item.command = state.command;
    item.backgroundColor = state.backgroundColor;
  }

  return {
    get cpuStatusBarItem() {
      return cpuStatusBarItem;
    },
    get memoryStatusBarItem() {
      return memoryStatusBarItem;
    },
    get gpuStatusBarItem() {
      return gpuStatusBarItem;
    },
    get diskStatusBarItem() {
      return diskStatusBarItem;
    },
    get networkStatusBarItem() {
      return networkStatusBarItem;
    },

    createItems() {
      const nextAlignment = readAlignment();

      if (currentAlignment === nextAlignment) {
        return;
      }

      const previousItems = currentAlignment === undefined ? undefined : {
        cpu: captureItemState(cpuStatusBarItem),
        memory: captureItemState(memoryStatusBarItem),
        gpu: captureItemState(gpuStatusBarItem),
        disk: captureItemState(diskStatusBarItem),
        network: captureItemState(networkStatusBarItem),
      };
      const wasVisible = statusBarsVisible;

      disposeItems();
      currentAlignment = nextAlignment;
      cpuStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? CPU_STATUS_PRIORITY : CPU_STATUS_PRIORITY_LEFT);
      cpuStatusBarItem.name = 'Moba CPU';

      memoryStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? MEMORY_STATUS_PRIORITY : MEMORY_STATUS_PRIORITY_LEFT);
      memoryStatusBarItem.name = 'Moba Memory';

      gpuStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? GPU_STATUS_PRIORITY : GPU_STATUS_PRIORITY_LEFT);
      gpuStatusBarItem.name = 'Moba GPU';

      diskStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? DISK_STATUS_PRIORITY : DISK_STATUS_PRIORITY_LEFT);
      diskStatusBarItem.name = 'Moba Disk';

      networkStatusBarItem = vscode.window.createStatusBarItem(nextAlignment,
        nextAlignment == vscode.StatusBarAlignment.Right ? NETWORK_STATUS_PRIORITY : NETWORK_STATUS_PRIORITY_LEFT);
      networkStatusBarItem.name = 'Moba Network';
      statusBarsVisible = false;

      restoreItemState(cpuStatusBarItem, previousItems?.cpu);
      restoreItemState(memoryStatusBarItem, previousItems?.memory);
      restoreItemState(gpuStatusBarItem, previousItems?.gpu);
      restoreItemState(diskStatusBarItem, previousItems?.disk);
      restoreItemState(networkStatusBarItem, previousItems?.network);

      if (wasVisible) {
        this.show();
      }
    },

    update(sample: ResourceSample) {
      const thresholds = readWarningThresholds();
      const hasCpuSample = enabledMonitors.cpu && sample.cpuPercent !== undefined;
      const hasMemorySample = enabledMonitors.memory && sample.memoryPercent !== undefined && sample.memoryUsedBytes !== undefined && sample.memoryTotalBytes !== undefined;
      const hasGpuSample = enabledMonitors.gpu && hasSampleProperty(sample, 'gpu');
      const hasDiskSample = enabledMonitors.disk && hasSampleProperty(sample, 'disk');
      const hasNetworkSample = enabledMonitors.network && hasSampleProperty(sample, 'network');

      if (hasCpuSample) {
        const cpuPercent = sample.cpuPercent!;
        latestCpuPercent = cpuPercent;
        const cpuTrendGraphConfig = readCpuTrendGraphConfig();
        let cpuTrendGraph = '';

        if (cpuTrendGraphConfig.enabled) {
          cpuHistory = [...cpuHistory, cpuPercent].slice(-cpuTrendGraphConfig.length);
          cpuTrendGraph = ` ${formatCpuTrendGraph(cpuHistory, cpuTrendGraphConfig.length)}`;
        } else if (cpuHistory.length > 0) {
          cpuHistory = [];
        }

        const cpuStatusText = `$(chip) ${formatPercent(cpuPercent)}${cpuTrendGraph}`;

        if (cpuStatusText !== previousCpuStatusText) {
          cpuStatusBarItem.text = cpuStatusText;
          previousCpuStatusText = cpuStatusText;
        }

        cpuStatusBarItem.command = SHOW_CPU_PROCESSES_COMMAND;
      }

      if (hasMemorySample) {
        const memoryPercent = sample.memoryPercent!;
        const memoryUsedBytes = sample.memoryUsedBytes!;
        const memoryTotalBytes = sample.memoryTotalBytes!;
        latestMemoryPercent = memoryPercent;
        latestMemoryUsedBytes = memoryUsedBytes;
        latestMemoryTotalBytes = memoryTotalBytes;
        const memoryStatusText = `$(server) ${formatStorageUsage(memoryUsedBytes, memoryTotalBytes)}`;

        if (memoryStatusText !== previousMemoryStatusText) {
          memoryStatusBarItem.text = memoryStatusText;
          previousMemoryStatusText = memoryStatusText;
        }

        memoryStatusBarItem.command = SHOW_MEMORY_PROCESSES_COMMAND;
      }

      if (hasGpuSample) {
        latestGpu = sample.gpu;

        if (sample.gpu) {
          const gpuStatusText = `$(device-desktop) ${formatGpuSummaryStatusText(sample.gpu.summary)}`;

          if (gpuStatusText !== previousGpuStatusText) {
            gpuStatusBarItem.text = gpuStatusText;
            previousGpuStatusText = gpuStatusText;
          }

          gpuStatusBarItem.command = CONFIGURE_GPU_DISPLAY_COMMAND;
          this.updateGpuTooltip(sample.gpu);
          gpuStatusBarItem.show();
        } else {
          gpuStatusBarItem.hide();
          previousGpuStatusText = undefined;
        }
      }

      if (hasDiskSample) {
        const diskStatusText = sample.disk ? `$(archive) ${formatDiskUsage(sample.disk)}` : '$(archive) --';
        diskStatusBarItem.text = diskStatusText;
        previousDiskStatusText = diskStatusText;
        this.updateDiskTooltip(sample.disk);
        diskStatusBarItem.show();
      }

      if (hasNetworkSample) {
        if (sample.network) {
          const networkStatusText = formatNetworkStatusText(sample.network, readShowNetworkUpload());

          if (networkStatusText !== previousNetworkStatusText) {
            networkStatusBarItem.text = networkStatusText;
            previousNetworkStatusText = networkStatusText;
          }

          networkStatusBarItem.command = undefined;
          networkStatusBarItem.tooltip = undefined;
          networkStatusBarItem.show();
        } else {
          networkStatusBarItem.hide();
          previousNetworkStatusText = undefined;
        }
      }

      if (hasCpuSample) {
        const cpuWarning = sample.cpuPercent! >= thresholds.cpuPercent;
        const cpuBackgroundColor = cpuWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
        cpuStatusBarItem.backgroundColor = cpuBackgroundColor;
        previousCpuWarning = cpuWarning;
      }

      if (hasMemorySample) {
        const memoryWarning = sample.memoryPercent! >= thresholds.memoryPercent;
        const memoryBackgroundColor = memoryWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
        memoryStatusBarItem.backgroundColor = memoryBackgroundColor;
        previousMemoryWarning = memoryWarning;
      }

      if (hasGpuSample) {
        const gpuWarning = sample.gpu ? sample.gpu.summary.utilizationPercent >= thresholds.gpuPercent : false;
        const gpuBackgroundColor = gpuWarning ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
        gpuStatusBarItem.backgroundColor = gpuBackgroundColor;
        previousGpuWarning = gpuWarning;
      }

      if (hasDiskSample) {
        const diskWarning = sample.disk ? sample.disk.diskPercent >= thresholds.diskPercent : false;
        const diskBackgroundColor = diskWarning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        diskStatusBarItem.backgroundColor = diskBackgroundColor;
        previousDiskWarning = diskWarning;
      }

      if (!statusBarsVisible) {
        if (enabledMonitors.cpu) {
          cpuStatusBarItem.show();
        }
        if (enabledMonitors.memory) {
          memoryStatusBarItem.show();
        }
        if (enabledMonitors.gpu && sample.gpu) {
          gpuStatusBarItem.show();
        }
        if (enabledMonitors.disk && previousDiskStatusText !== undefined) {
          diskStatusBarItem.show();
        }
        if (enabledMonitors.network && previousNetworkStatusText !== undefined) {
          networkStatusBarItem.show();
        }
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

    updateGpuTooltip(gpu?: GpuAggregateSample) {
      const thresholds = readWarningThresholds();
      const activeGpu = gpu ?? latestGpu;

      const lines = ['**GPU**', ''];

      if (!activeGpu) {
        lines.push('No GPU telemetry available.');
        lines.push('');
        lines.push(`Warning threshold: ${formatPercent(thresholds.gpuPercent)}`);
        updateGpuTooltipText(lines.join('\n\n'));
        return;
      }

      lines.push(`Current summary: ${formatGpuSummaryTooltipLine(activeGpu.summary)}`);
      appendGpuTooltipSection(lines, 'Discrete GPUs', activeGpu.devices.filter((device) => device.category === 'discrete'));
      appendGpuTooltipSection(lines, 'Integrated GPUs', activeGpu.devices.filter((device) => device.category === 'integrated'));
      appendGpuTooltipSection(lines, 'Unknown GPUs', activeGpu.devices.filter((device) => device.category === 'unknown'));

      lines.push('Click the GPU status item to choose which detected GPUs are summarized or to override a category.');
      lines.push(`Warning threshold: ${formatPercent(thresholds.gpuPercent)}`);
      updateGpuTooltipText(lines.join('\n\n'));
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

    setEnabledMonitors(nextEnabledMonitors: EnabledMonitors) {
      enabledMonitors = nextEnabledMonitors;

      if (!enabledMonitors.cpu) {
        cpuStatusBarItem.hide();
        cpuStatusBarItem.backgroundColor = undefined;
        previousCpuStatusText = undefined;
        latestCpuPercent = 0;
        cpuHistory = [];
        previousCpuWarning = false;
      }

      if (!enabledMonitors.memory) {
        memoryStatusBarItem.hide();
        memoryStatusBarItem.backgroundColor = undefined;
        previousMemoryStatusText = undefined;
        latestMemoryPercent = 0;
        latestMemoryUsedBytes = 0;
        latestMemoryTotalBytes = 0;
        previousMemoryWarning = false;
      }

      if (!enabledMonitors.gpu) {
        gpuStatusBarItem.hide();
        gpuStatusBarItem.backgroundColor = undefined;
        previousGpuStatusText = undefined;
        previousGpuTooltipText = undefined;
        gpuStatusBarItem.tooltip = undefined;
        latestGpu = undefined;
        previousGpuWarning = false;
      }

      if (!enabledMonitors.disk) {
        diskStatusBarItem.hide();
        diskStatusBarItem.backgroundColor = undefined;
        previousDiskStatusText = undefined;
        previousDiskWarning = false;
      }

      if (!enabledMonitors.network) {
        networkStatusBarItem.hide();
        previousNetworkStatusText = undefined;
      }

      statusBarsVisible = false;
    },

    setDiskTargetPath(path: string) {
      diskTargetPath = path;
    },

    reset() {
      previousCpuStatusText = undefined;
      previousMemoryStatusText = undefined;
      previousGpuStatusText = undefined;
      previousDiskStatusText = undefined;
      previousNetworkStatusText = undefined;
      previousGpuTooltipText = undefined;
      latestCpuPercent = 0;
      latestMemoryPercent = 0;
      latestMemoryUsedBytes = 0;
      latestMemoryTotalBytes = 0;
      latestGpu = undefined;
      cpuHistory = [];
      previousCpuWarning = false;
      previousMemoryWarning = false;
      previousGpuWarning = false;
      previousDiskWarning = false;
      cpuStatusBarItem.backgroundColor = undefined;
      memoryStatusBarItem.backgroundColor = undefined;
      gpuStatusBarItem.backgroundColor = undefined;
      gpuStatusBarItem.tooltip = undefined;
      diskStatusBarItem.backgroundColor = undefined;
      networkStatusBarItem.tooltip = undefined;
      statusBarsVisible = false;
    },

    getLatestMetrics() {
      return {
        cpuPercent: latestCpuPercent,
        memoryPercent: latestMemoryPercent,
        memoryUsedBytes: latestMemoryUsedBytes,
      };
    },

    show() {
      if (enabledMonitors.cpu) {
        cpuStatusBarItem.show();
      }
      if (enabledMonitors.memory) {
        memoryStatusBarItem.show();
      }
      if (enabledMonitors.gpu && latestGpu) {
        gpuStatusBarItem.show();
      }
      if (enabledMonitors.disk) {
        diskStatusBarItem.show();
      }
      if (enabledMonitors.network && previousNetworkStatusText) {
        networkStatusBarItem.show();
      }
      statusBarsVisible = true;
    },

    hide() {
      cpuStatusBarItem.hide();
      memoryStatusBarItem.hide();
      gpuStatusBarItem.hide();
      diskStatusBarItem.hide();
      networkStatusBarItem.hide();
      statusBarsVisible = false;
    },

    dispose() {
      disposeItems();
    },
  };

  function updateGpuTooltipText(nextTooltipText: string): void {
    if (gpuStatusBarItem.tooltip === undefined || nextTooltipText !== previousGpuTooltipText) {
      gpuStatusBarItem.tooltip = new vscode.MarkdownString(nextTooltipText);
      previousGpuTooltipText = nextTooltipText;
    }
  }
}

function hasSampleProperty(sample: ResourceSample, key: keyof ResourceSample): boolean {
  return Object.prototype.hasOwnProperty.call(sample, key);
}

function formatNetworkStatusText(network: NetworkSample, showUpload: boolean): string {
  const downloadText = `$(arrow-down) ${formatTransferRate(network.downloadBytesPerSecond)}`;

  if (!showUpload) {
    return downloadText;
  }

  return `${downloadText} $(arrow-up) ${formatTransferRate(network.uploadBytesPerSecond)}`;
}

function formatGpuTooltipLine(device: GpuDeviceSample): string {
  const utilization = device.utilizationPercent !== undefined ? formatPrecisePercent(device.utilizationPercent) : '--';
  const memory = formatGpuMemory(device);
  return `${formatGpuLabel(device)} · ${formatGpuCategory(device.category)} · ${utilization} · ${memory}`;
}

function formatGpuLabel(device: GpuDeviceSample): string {
  return `GPU ${device.index} · ${device.name}`;
}

function formatGpuMemory(device: GpuDeviceSample): string {
  if (device.memoryUsedBytes !== undefined && device.memoryTotalBytes !== undefined) {
    return `${formatStorageUsage(device.memoryUsedBytes, device.memoryTotalBytes)} VRAM`;
  }

  if (device.memoryUsedBytes !== undefined) {
    return `${formatBytes(device.memoryUsedBytes)} VRAM`;
  }

  return 'VRAM unavailable';
}

function formatGpuSummaryStatusText(summary: GpuSummarySample): string {
  if (summary.deviceCount === 0) {
    return `${summary.label} --`;
  }

  return `${summary.label} ${formatStatusBarPrecisePercent(summary.utilizationPercent)}${formatGpuSummaryPanelMemory(summary)}`;
}

function formatGpuSummaryPanelMemory(summary: GpuSummarySample): string {
  if (summary.memoryUsedBytes !== undefined && summary.memoryTotalBytes !== undefined) {
    return ` ${formatCompactStorageUsage(summary.memoryUsedBytes, summary.memoryTotalBytes)}`;
  }

  if (summary.memoryUsedBytes !== undefined) {
    return ` ${formatBytes(summary.memoryUsedBytes)}`;
  }

  return '';
}

function formatGpuSummaryTooltipLine(summary: GpuSummarySample): string {
  if (summary.deviceCount === 0) {
    return `${summary.label} unavailable`;
  }

  return `${summary.label} · ${formatPrecisePercent(summary.utilizationPercent)}${formatGpuSummaryTooltipMemory(summary)}`;
}

function formatGpuSummaryTooltipMemory(summary: GpuSummarySample): string {
  if (summary.memoryUsedBytes !== undefined && summary.memoryTotalBytes !== undefined) {
    return ` · ${formatStorageUsage(summary.memoryUsedBytes, summary.memoryTotalBytes)} VRAM`;
  }

  if (summary.memoryUsedBytes !== undefined) {
    return ` · ${formatBytes(summary.memoryUsedBytes)} VRAM`;
  }

  return '';
}

function appendGpuTooltipSection(lines: string[], title: string, devices: GpuDeviceSample[]): void {
  if (devices.length === 0) {
    return;
  }

  lines.push([
    `**${title}**`,
    ...devices.map((device) => `- ${formatGpuTooltipLine(device)}`),
  ].join('\n'));
}

function formatGpuCategory(category: GpuDeviceCategory | undefined): string {
  switch (category) {
    case 'discrete':
      return 'dGPU';
    case 'integrated':
      return 'iGPU';
    default:
      return 'GPU';
  }
}
