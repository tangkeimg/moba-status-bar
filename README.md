![Version](https://img.shields.io/visual-studio-marketplace/v/tangkeimg.moba-status-bar)
[![OpenVSX Downloads](https://img.shields.io/open-vsx/dt/tangkeimg/moba-status-bar)](https://open-vsx.org/extension/tangkeimg/moba-status-bar)
![License](https://img.shields.io/badge/license-MIT-blue)

# Moba Status Bar

CPU, GPU, memory, and disk usage monitor with a compact trend graph in the VS Code status bar.

Keep system resource usage visible at all times without leaving your editor. Moba Status Bar shows live CPU, GPU, memory, and disk usage directly in the status bar, with a built-in trend graph and one-click access to top resource-consuming processes.

[View on Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tangkeimg.moba-status-bar)

## Preview

![Moba Status Bar preview](./pic.png)

## Why Moba Status Bar?

- **Live CPU usage with trend graph** directly in the status bar
- **GPU usage with multi-GPU tooltip**
- **Memory usage at a glance**
- **Disk usage for current workspace**
- **One-click process inspection** (CPU & memory)
- **Automatic warning highlights** when usage is high
- **Lightweight and configurable**

## Quick Start

Install the extension and CPU, GPU, memory, and disk usage will appear automatically in the status bar when supported by your machine and platform.

No setup required. Customize behavior later in Settings if needed.

## Features

- **CPU usage with trend graph**: shows real-time CPU usage with a compact trend graph in the status bar.
- **GPU usage in the status bar**: shows an automatic GPU summary that prefers discrete GPUs when present, keeps integrated and discrete memory separate, and includes VRAM usage when available. GPU telemetry uses lightweight platform-specific backends, and the tooltip groups all detected GPUs by type.
- **Memory usage in the status bar**: shows used memory and total memory, for example `8.4GB / 16.0GB`.
- **Workspace disk usage**: shows usage for the disk that contains your first workspace folder. If no workspace is open, it uses your home directory.
- **Top CPU processes**: click the CPU item or run the command to see the top 5 CPU-consuming processes.
- **Top memory processes**: click the memory item or run the command to see the top 5 memory-consuming processes.
- **Warning highlights**: CPU, GPU, memory, and disk items can highlight automatically when usage reaches your configured threshold.
- **Configurable refresh rate**: choose how often enabled monitors update.

## Status Bar Items

After installation, the extension starts automatically when VS Code finishes launching.

| Item | What it shows | Action |
| --- | --- | --- |
| `$(chip)` CPU | Current CPU usage trend and percentage | Click to show top CPU processes |
| `$(server)` Memory | Used memory / total memory | Click to show top memory processes |
| `$(device-desktop)` GPU | Auto-selected GPU summary usage and VRAM when available; hover to inspect grouped per-GPU details | Click to configure detected GPUs; hover to inspect grouped per-GPU usage and VRAM data |
| `$(archive)` Disk | Workspace disk label and usage percentage | Hover to view target path and usage |

## GPU Platform Support

GPU monitoring is best-effort and never blocks the rest of the status bar. If GPU telemetry is unsupported, unavailable, times out, or returns invalid data, the GPU item is hidden and CPU, memory, and disk monitoring continue normally.

| Platform | Backend | Behavior |
| --- | --- | --- |
| Windows | PowerShell `Get-Counter` GPU Engine and GPU Adapter Memory counters, with registry metadata for names and VRAM totals | Shows per-GPU utilization and dedicated VRAM when counters are available. |
| Linux | `nvidia-smi` for NVIDIA GPUs, or `rocm-smi` for AMD ROCm GPUs when installed | Shows utilization and VRAM from the available vendor tool. Missing tools, driver errors, command timeouts, or parse failures fall back to no GPU item. |
| macOS | No lightweight built-in GPU telemetry backend | GPU monitoring falls back to hidden; the extension does not error or stop refreshing other monitors. |
| Other platforms | None | GPU monitoring falls back to hidden. |

## Commands

Open the Command Palette with `Ctrl+Shift+P` / `Cmd+Shift+P` and run:

| Command | Description |
| --- | --- |
| `Moba Status Bar: Show Top CPU Processes` | Shows the top 5 CPU-consuming processes. |
| `Moba Status Bar: Show Top Memory Processes` | Shows the top 5 memory-consuming processes. |
| `Moba Status Bar: Configure GPU Display` | Opens a picker for detected GPUs so you can change the GPU summary mode, choose specific GPUs, or override a GPU category without typing device names manually. |

## Settings

You can configure Moba Status Bar from VS Code settings.

| Setting | Default | Description |
| --- | --- | --- |
| `mobaStatusBar.cpuEnabled` | `true` | Enable CPU monitoring. When disabled, CPU sampling and CPU trend history are not collected. |
| `mobaStatusBar.cpuWarningThresholdPercent` | `90` | Highlight the CPU item when CPU usage is at or above this percentage. |
| `mobaStatusBar.showCpuTrendGraph` | `true` | Show a compact CPU usage trend graph in the status bar. |
| `mobaStatusBar.cpuTrendGraphLength` | `6` | Number of samples shown in the CPU trend graph. |
| `mobaStatusBar.memoryEnabled` | `true` | Enable memory monitoring. When disabled, memory usage is not sampled. |
| `mobaStatusBar.memoryWarningThresholdPercent` | `90` | Highlight the memory item when memory usage is at or above this percentage. |
| `mobaStatusBar.gpuEnabled` | `true` | Enable GPU monitoring. When disabled, GPU sampling is not collected. |
| `mobaStatusBar.gpuWarningThresholdPercent` | `90` | Highlight the GPU item when GPU usage is at or above this percentage. |
| `mobaStatusBar.diskEnabled` | `true` | Enable disk monitoring. When disabled, disk usage is not sampled. |
| `mobaStatusBar.diskWarningThresholdPercent` | `85` | Highlight the disk item when disk usage is at or above this percentage. |
| `mobaStatusBar.refreshIntervalMs` | `1000` | Enabled monitor refresh interval in milliseconds. Values below `500` are clamped to `500`. |
| `mobaStatusBar.alignment` | `right` | Place the status bar items on the `left` or `right` side of the VS Code status bar. |
| `mobaStatusBar.enabled` | `true` | Enable or disable the status bar monitor. |

Example `settings.json`:

```json
{
  "mobaStatusBar.cpuEnabled": true,
  "mobaStatusBar.cpuWarningThresholdPercent": 85,
  "mobaStatusBar.showCpuTrendGraph": true,
  "mobaStatusBar.cpuTrendGraphLength": 6,
  "mobaStatusBar.memoryEnabled": true,
  "mobaStatusBar.memoryWarningThresholdPercent": 90,
  "mobaStatusBar.gpuEnabled": true,
  "mobaStatusBar.gpuWarningThresholdPercent": 90,
  "mobaStatusBar.diskEnabled": true,
  "mobaStatusBar.diskWarningThresholdPercent": 80,
  "mobaStatusBar.refreshIntervalMs": 1500,
  "mobaStatusBar.alignment": "right",
  "mobaStatusBar.enabled": true
}
```

Tip: configure GPU display behavior from the GPU status bar item itself or run `Moba Status Bar: Configure GPU Display`, then choose from the detected GPU list.

The GPU display mode, selected devices, and category overrides are stored internally by the extension instead of appearing as public VS Code settings.

## Notes

- Disk usage is cached and refreshed less often than CPU and memory to keep the extension lightweight.
- GPU monitoring uses the lightest available backend for the current platform. On unsupported systems or when runtime GPU telemetry is unavailable, the GPU item stays hidden.
- Disabled monitors are not sampled in the refresh loop.
- Process lists are collected only when you open them.
- On Windows, process data is collected through PowerShell/CIM. On macOS and Linux, it is collected through `ps`.
- GPU monitoring supports multiple GPUs in a single item. The tooltip expands every detected device and degrades gracefully when VRAM totals are unavailable or fresh GPU telemetry cannot be read.
- The GPU configuration command stores exact detected device ids when you pick GPUs interactively, so users normally do not need to know or type the raw GPU names themselves.

## License

[MIT](LICENSE)
