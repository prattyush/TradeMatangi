# Trade Matangi Desktop Charts

Phase 16's isolated Windows chart companion. This workspace is deliberately chart-only: it has no order, wallet, position, strategy, or broker-credential capability.

## Prerequisites

- Node.js 20+ and Rust stable
- Windows with WebView2 for a native build

## Commands

```bash
npm install
npm test
npm run build
npm run tauri dev
```

The Sprint 0 scaffold establishes renderer-neutral contracts, ordered snapshot/current-bar state handling, a restrictive Tauri CSP, and a native host-state test. Sprint 1 stores token bundles through the operating-system keyring (Windows Credential Manager), never a plaintext app configuration file. The KLineCharts renderer is wired in the next increment after the package/API proof on a Windows machine.
