# Changelog

All notable changes to the "Moba Status Bar" extension will be documented in this file.

<!-- markdownlint-disable MD024 -->

## [1.3.3] - 2026-04-28

### Fixed

- Fixed network status display being delayed by slower GPU or disk telemetry collection.

## [1.3.2] - 2026-04-27

### Fixed

- Fixed Windows GPU sampling by grouping GPU counter samples per physical GPU before calculating utilization and memory usage.
- Increased the Windows GPU counter command timeout to reduce missing GPU status updates on slower systems.
- Fixed warning threshold normalization so configured upper-bound values are preserved consistently at runtime.
- Fixed warning threshold tooltip formatting so the displayed value matches the configured threshold.

## [1.3.1] - 2026-04-26

### Added

- Added a Linux amdgpu sysfs fallback backend so AMD integrated GPUs can surface utilization and VRAM data even when `rocm-smi` is not installed.

### Changed

- Documented the Linux amdgpu sysfs fallback path and support expectations in the README.

### Fixed

- Hardened Linux GPU backend detection so amdgpu sysfs telemetry only activates when real counters are available, reducing the chance of empty GPU items on unsupported AMD systems.

## [1.3.0] - 2026-04-25

### Added

- Added lightweight network monitoring for Windows and Linux, with active-interface selection and adaptive sampling.
- Added a compact network status bar item that shows download throughput by default and can optionally include upload throughput.

### Changed

- Documented network monitoring support, settings, and platform behavior in the README.
- Kept the network item focused on a tooltip-free compact display so it uses less status bar space by default.
- Changed network monitoring to stay hidden by default unless `mobaStatusBar.networkEnabled` is turned on.
