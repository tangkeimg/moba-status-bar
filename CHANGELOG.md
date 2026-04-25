# Changelog

All notable changes to the "Moba Status Bar" extension will be documented in this file.

<!-- markdownlint-disable MD024 -->

## [1.3.0] - 2026-04-25

### Added

- Added lightweight network monitoring for Windows and Linux, with active-interface selection and adaptive sampling.
- Added a compact network status bar item that shows download throughput by default and can optionally include upload throughput.

### Changed

- Documented network monitoring support, settings, and platform behavior in the README.
- Kept the network item focused on a tooltip-free compact display so it uses less status bar space by default.

### Fixed

- Fixed network rate rendering to use a stable-width status text so normal value changes do not resize the item.

## [1.2.7] - 2026-04-25

### Added

- Added interactive GPU display configuration from the GPU status item and command palette, including detected-GPU selection and manual GPU category overrides.
- Added grouped GPU summaries and tooltips that classify detected devices as integrated, discrete, or unknown, while keeping integrated and discrete memory separate.

### Changed

- Changed automatic GPU summaries to prefer active discrete GPUs, while explicit discrete, integrated, and selected modes now keep clear unavailable states instead of silently falling back.
- Moved GPU display mode, selected devices, and category overrides out of public VS Code settings and into the interactive Configure GPU Display flow.

### Fixed

- Fixed selected-GPU configuration so empty selections stay in Selected mode and surface `Selected GPU unavailable` instead of resetting to Auto.
- Fixed Linux GPU backend handling so the sampler can fall back between `nvidia-smi` and `rocm-smi` when one vendor tool is installed but unusable.
- Fixed ROCm VRAM refresh timing so Linux AMD memory data continues updating on schedule.

## [1.2.6] - 2026-04-24

### Fixed

- Fixed GPU status visibility in left-aligned mode by giving each status bar item a stable id and ensuring the GPU item keeps enough priority to remain visible.

## [1.2.5] - 2026-04-24

### Added

- Added GPU monitoring backends for Windows and Linux, including multi-GPU status and VRAM data when available.

### Changed

- Documented GPU platform support and fallback behavior for Windows, Linux, macOS, and unsupported systems.

### Fixed

- Hardened GPU fallback handling so backend detection failures, Linux GPU command failures, macOS unsupported telemetry, or Windows GPU metadata errors fall back cleanly instead of surfacing refresh errors.
- Fixed GPU status bar text jitter when utilization moved from a single-digit value to a double-digit value.

## [0.1.2] - 2026-04-24

### Changed

- Improved Top CPU Processes and Top Memory Processes on Unix-like systems by parsing process IDs from `ps` output and showing them alongside process names.

## [0.1.1] - 2026-04-24

### Fixed

- Fixed an issue on Windows where the Top CPU Processes list could be empty the first time it was opened.
- Improved the Top CPU Processes picker so it opens immediately while CPU process data is being collected.
