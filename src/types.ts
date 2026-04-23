export type CpuSnapshot = {
  idle: number;
  total: number;
};

export type ResourceSample = {
  cpuPercent?: number;
  memoryPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  disk?: DiskSample;
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
  diskPercent: number;
};

export type CpuTrendGraphConfig = {
  enabled: boolean;
  length: number;
};

export type EnabledMonitors = {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
};
