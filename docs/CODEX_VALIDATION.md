# Codex adapter validation — 2026-09-26

Baseline: `d26d05587ea93ef7bb27147b901d88da8a18dd7c` (v1.8.0). Target: source v1.9.0 on `codex/jev-orchestration`. This document describes source/protocol tests, **not an activated live deployment**.

## Observed local evidence

| Check | Observed result |
|---|---|
| Node built-in regression suite, Windows, Node 24.18.0 | 75 passed, 0 failed, 0 skipped; exit 0 |
| `.mjs` syntax checks in plugin/scripts/hooks/tests | 28 checked, 0 failed |
| Isolated Codex artifact | 14 allowlisted files; builds only into an absent directory |
| Bundled official Codex plugin validator | PASS on isolated artifact |
| Isolated stdio metadata/health | version 1.9.0, eight tools; fake home, no key, no API call or state write |
| Independent source reviewer | PASS for corrected scope; no remaining HIGH/MEDIUM finding in that scope |

All provider responses in regression tests are mocks. Legacy subprocess fixtures replace the home and block socket connection. New controller tests use injected Jev responses; package tests call metadata/health only. No real TypeSafe, GitNexus, hosted model or new Codex runtime was used to claim these results. The user-owned key entry file is outside the repository and is not included in evidence.

## Test-first and independent correction

- Legacy initial regression: 19 FAIL, 2 PASS; strengthened timeout/corrupt-ledger/unbound-child failures were reproduced before fixes. Final legacy group: 32 PASS.
- Context initial module absence FAIL; additional edge-case failures fixed. Final context group: 26 PASS.
- Controller initial module absence FAIL. Final controller group: 15 PASS.
- Self-contained package + lifecycle group: 2 PASS.
- Independent review reproduced interrupt queue starvation, missing claim requirement, lost negative completion, inherited-property replay rejection and generated event-ID collision. All were corrected and given regression tests. The reviewer separately verified the state transitions in memory; the full disk suite and plugin validator were run by the parent, not represented as independently rerun.

Final controller byte SHA256 (reviewed logic; EOF whitespace normalized afterward): `1a909c51383a67692f996d89f0aeeb0c235d21d087ce54c4df03f152aeff0dd4`.

## Preserved boundaries / not established

- Parent host must feed events and execute/ack actual native actions. The Node MCP control plane is not a background agent or an autonomous native-tool caller.
- Claimed but uncertain native effects require receipt reconciliation. There is no automatic retry that could duplicate a spawn/correction.
- Snapshot freshness/identity and Skill file hashes are checked; host-supplied capabilities, graph provenance and native receipts are not authenticated attestation.
- Lifecycle hooks are advisory. Per-child pre-tool enforcement, effective OS permissions and whole-process coverage are not established.
- Completion checks evidence structure and references. Parent independent inspection of original artifacts remains mandatory; hashes alone do not prove tests ran.
- Legacy FIFO/catalog/subgoal registry and legacy helper packaging remain outside the Codex artifact. Their removal from this path is not a claim that every legacy architectural issue is fixed.
- TypeSafe live authentication/routing, live GitNexus access, actual native model/effort selection, full in-progress live correction and installation/trust are **NOT_VERIFIED**.
- Hosted Linux/Windows CI results belong to the exact published commit and are reported in GitHub, not inferred from local Windows tests.

## Reproduce

Run `npm test` with Node 22 or 24. No dependency install is needed. Build the isolated plugin using `node scripts/package-codex.mjs <absolute-absent-output-dir>`. The packaged source does not include `.env`, ledgers, cached inventories or native transcript data. See [protocol](../plugin/codex/PROTOCOL.md) for state/egress/native-effect contracts and [changes](V1_9_CHANGELOG.md) for intentional legacy safety-contract changes.
