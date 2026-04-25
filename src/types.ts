export type CpuSnapshot = {
  idle: number;
  total: number;
};

export type ResourceSample = {
  cpuPercent?: number;
  memoryPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  gpu?: GpuAggregateSample;
  disk?: DiskSample;
  network?: NetworkSample;
};

export type GpuDeviceSample = {
  id: string;
  index: number;
  name: string;
  category?: GpuDeviceCategory;
  utilizationPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
};

export type GpuDeviceCategory = 'integrated' | 'discrete' | 'unknown';

export type GpuSummaryMode = 'auto' | 'discrete' | 'integrated' | 'selected';

export type GpuDisplayConfig = {
  summaryMode: GpuSummaryMode;
  selectedDeviceMatchers: string[];
  categoryOverrides: Record<string, GpuDeviceCategory>;
};

export type GpuSummarySample = {
  id: string;
  label: string;
  category: GpuDeviceCategory | 'mixed';
  deviceCount: number;
  deviceIds: string[];
  utilizationPercent: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
};

export type GpuAggregateSample = {
  devices: GpuDeviceSample[];
  summary: GpuSummarySample;
  groups: {
    all: GpuSummarySample;
    integrated?: GpuSummarySample;
    discrete?: GpuSummarySample;
    unknown?: GpuSummarySample;
  };
  aggregateUtilizationPercent: number;
  aggregateMemoryUsedBytes?: number;
  aggregateMemoryTotalBytes?: number;
  aggregateMemoryPercent?: number;
  hasAnyMemoryData: boolean;
};

export type CpuProcess = {
  name: string;
  cpuPercent: number;
};

export type MemoryProcess = {
  name: string;
  memoryPercent: number;
  memoryBytes: number;
};

export type DiskSample = {
  diskPath: string;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
};

export type NetworkSample = {
  interfaceName: string;
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
};

export type WarningThresholds = {
  cpuPercent: number;
  memoryPercent: number;
  gpuPercent: number;
  diskPercent: number;
};

export type CpuTrendGraphConfig = {
  enabled: boolean;
  length: number;
};

export type EnabledMonitors = {
  cpu: boolean;
  memory: boolean;
  gpu: boolean;
  disk: boolean;
  network: boolean;
};
