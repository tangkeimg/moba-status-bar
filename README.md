# Moba Status Bar

A lightweight VS Code status bar resource monitor inspired by MobaXterm.

## Features

- Shows CPU usage in the VS Code status bar.
- Shows memory usage in the VS Code status bar.
- Shows workspace disk usage in the VS Code status bar.
- Click the CPU status item to collect and show the top 5 CPU processes.
- Click the memory status item to collect and show the top 5 memory processes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mobaStatusBar.enabled` | `true` | Enable or disable the status bar monitor. |
| `mobaStatusBar.refreshIntervalMs` | `1000` | Refresh interval in milliseconds. Values below `500` are clamped to `500`. |
| `mobaStatusBar.cpuWarningThresholdPercent` | `90` | Show a warning background when CPU usage reaches this percentage. |
| `mobaStatusBar.memoryWarningThresholdPercent` | `90` | Show a warning background when memory usage reaches this percentage. |
| `mobaStatusBar.diskWarningThresholdPercent` | `90` | Show a warning background when disk usage reaches this percentage. |

## Development

```sh
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
