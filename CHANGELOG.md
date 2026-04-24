# Changelog

All notable changes to the "Moba Status Bar" extension will be documented in this file.

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
