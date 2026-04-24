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
};

export type GpuDeviceSample = {
  id: string;
  index: number;
  name: string;
  utilizationPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
};

export type GpuAggregateSample = {
  devices: GpuDeviceSample[];
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
};
