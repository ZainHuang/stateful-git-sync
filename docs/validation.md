# Stateful Git Sync validation

## 1.2.0 - Incremental sync and smart verification (2026-10-10)

- Genuine RED → GREEN → REFACTOR evidence covers production read/hash/API measurement, dirty-file and immutable-metadata reuse, full fallback, standalone full Verify, three-phase activity, reduced stat calls, coalesced durable event writes, legacy Recovery index refresh, stale Verified after subsequent edits, and live stage elapsed time. The logs remain under the ignored `test-results/v12-*` paths.
- `npm run check` passes TypeScript, standard and Obsidian ESLint, all 825 tests across 43 files, and the mobile-safe bundle with `obsidian` as the only external dependency. The test total includes the existing 100 seeded protocol property cases and 30 new incremental-scanner seeds with 40 independent byte-oracle comparisons each.
- All 19 isolated Obsidian suites pass their fixture assertions: 112 checks and 105 screenshots, with zero captured Console errors. Coverage includes actual Windows Vault events, 540 files, mobile viewport/keyboard/safe-area emulation, conflicts, deletion confirmation, adoption, BASE failure diagnostics, lost PATCH, full Recovery, restart, resume, missing events, index damage, read-only full Verify and shared activity events. The read-only Preview suite keeps `passed_with_live_read_pending`: its optional live GitHub probe was deliberately skipped, rather than treated as external acceptance. Branch writes use `force:false`.
- Three sequential paired 540-file disk/HTTP-fixture benchmark runs give median daily sync reductions: no change 2288.5 → 403.8 ms (82.4%); one edit 2612.8 → 666.3 ms (74.5%); ten edits 2646.6 → 703.9 ms (73.4%); 25 renames 3135.4 → 771.0 ms (75.4%). No-change content reads fall from 3240 to 8, hash bytes from 51,782,640 to 524,288, and API calls from 12 to 6. First initialization (2988.7 → 3702.5 ms) and full local-write Recovery (520.8 → 625.8 ms) remain slower in this sample; their full-verification boundaries are retained.
- Full reconciliation is required on restart, mobile resume/foreground, damaged/unavailable indexes, changed ignore scope, unexpected inventory/stat changes, sample mismatch, 24-hour expiry, clock rollback and the twentieth completed sync. Standalone Verify and local-write Recovery use full content audits. Equal-stat missed edits are covered by rotating byte samples and bounded full audits; metadata is never permanent content proof.
- Incremental transactions keep both versions of changed paths while retaining complete authoritative maps. BASE advances only after remote proof, changed/full local verification and local-state read-back. The existing published Recovery path that preserves subsequent edits is distinctly labeled `Published Snapshot Verified`; legacy full Recovery reports `Full Integrity Verified` and refreshes the same derived index.
- The package keeps plugin ID `local-mirror-sync` and display name Stateful Git Sync, with version 1.2.0. Physical iOS/Android performance and live GitHub latency/rate limits remain unmeasured. All test writes are to generated isolated Vaults and synthetic repositories; the reported daily 14-minute sync was not reproduced on the user's personal Vault.

## 1.1.23 - Preview startup and bounded reads (2026-10-06)

- RED reproduced 200 metadata/cache writes for 100 existing-file startup announcements, missing local-wait progress, unbounded metadata and pending-Recovery reads, delayed Cancel, and stalled GitHub GETs. Seven assertions failed before implementation; 30 existing/follow-up assertions passed. The RED log is retained in the ignored `test-results/tdd/preview-startup-red.log`.
- GREEN: `npm run check` passed TypeScript, standard and Obsidian lint, all 759 tests across 37 files (including the seeded property suite), and the mobile-safe build. Final 1.1.23 metadata passed all five branding/upgrade compatibility tests and was rebuilt. Initial test-fixture type and timer/rejection lint diagnostics were corrected without suppressing rules or changing dependencies.
- The isolated real Obsidian startup/timeout suite passed five checks with zero Console errors. At 390px, local-wait text and Cancel are visible without horizontal overflow; cancellation starts no GitHub read or BASE update. Local and GitHub stalls report their 30-second deadlines, late read results cannot produce a plan, explicit retry works, and real post-startup create events remain observed. Its fixture recorded nine GETs, zero POSTs and zero PATCHes.
- The final 1.1.23 V1 Obsidian regression passed all 13 checks with zero Console errors, including Push/Pull, mobile rename/conflict/delete, Bootstrap, lost-PATCH Recovery, standalone read-only Verify, both explicit Legacy Adoption choices and Empty filtering. No branch update used `force:true`. All application checks used generated isolated Vaults.
- The installation candidate ZIP contains exactly `main.js`, `manifest.json` and `styles.css` inside the compatible `local-mirror-sync` directory; archive read-back SHA-256 matches each built asset. Physical Android installation and the user's exact stall remain unverified; no live note repository or daily Vault was changed by this task.
- The public candidate audit included the two new test/smoke files: 148 source files and both bundles, with zero findings. Final diff review found only this fix, its tests, candidate metadata and implementation/validation records.

## 1.1.22 - Published Recovery with local changes (2026-10-06)

- RED reproduced the hidden affected path and missing fresh-Preview action for interrupted published PULL/Bootstrap transactions. The old real Obsidian bundle also failed because `LOCAL_CHANGED` omitted `note.md`. An earlier UI fixture interception failed before the target interaction and is retained separately as setup evidence, not counted as RED.
- Added 23 regression cases covering explicit replan with unchanged BASE/current files, verified backup blobs and durable audit, partial PULL, Bootstrap/ATTACH, descendant HEAD, recorded rename/delete, adoption backups, no PASS history, and target/device/scope/BASE/history/blob/audit/race failures. Existing tests and safety assertions remain intact. Initial new assertions were aligned with the existing `CONFLICT_ADD_ADD` and `ALREADY_CONVERGED` labels; planner behavior was not changed.
- `npm run check` passed TypeScript, standard and Obsidian ESLint, all 751 tests across 36 files, and the mobile-safe build. The separate 100-case seeded property suite passed.
- The final 1.1.22 isolated Obsidian Recovery suite passed eight checks with zero console errors. It verifies path diagnostics, enabled Resume, blocked Abort, the explicit fresh-Preview action at 390px, retained journals, unchanged BASE/Local/remote HEAD and GET-only recovery requests. Resulting conflicts remain unresolved and Sync & Verify stays disabled until reviewed. V1 lifecycle (13 checks) and legacy current-HEAD Recovery (11 checks) also passed with zero console errors.
- Public candidate audit passed with 146 files, two bundles and zero findings. The installation ZIP contains exactly `main.js`, `manifest.json` and `styles.css`; their bytes match the built assets. Recovery pointers/audits are local metadata; Manifest, BASE advancement, normal planner and Abort safety retain their existing rules.
- Logs and screenshots are retained in the ignored `test-results/recovery-local-changes` and generated `artifacts/v1-e2e-*` directories. Tests use generated Vaults and a synthetic GitHub fixture; they do not operate the user's phone or daily Vault.

## 1.1.21 - Recovery and Preview loop (2026-10-06)

- RED reproduced six initial service failures and a real Obsidian Recovery dialog offering a Preview that immediately returns to Recovery. Two further RED cases covered HTTP 503 and offline guidance during Resume.
- Recovery now reports the blocking condition and keeps retries in Recovery. Confirmed published adoption without local writes verifies the original immutable commit, Manifest/tree and backup before completing that snapshot's BASE; later edits remain for normal conflict review.
- An initial full regression caught the existing prepared-adoption descendant restriction. The implementation was narrowed to preserve it; no existing safety assertion was removed or weakened. A new test initially used the wrong conflict label and was corrected to the existing `CONFLICT_CONTENT` contract.
- `npm run check` passed TypeScript, both ESLint configurations, all 728 tests across 35 files (including 100 seeded property cases), and the mobile-safe build.
- The final isolated Obsidian Recovery suite passed seven checks with zero console errors. At 390px it covers blocked Preview removal, target/network failures and retries, safe Abort, published-adoption recovery after another device advances main, and normal Push/Pull/conflict Preview. Successful published recovery makes GET-only requests and preserves later local files and current remote content.
- Final V1 lifecycle and legacy current-HEAD Recovery regressions passed with zero console errors, including both adoption choices and the explicitly offered legacy fresh-Preview path.
- GitHub publication, daily-Vault installation and physical phone verification are separate deployment steps. Tests use generated Vaults and a synthetic GitHub fixture.

## 1.1.18

- Reproduced the Community review locally with the official Obsidian ESLint configuration: 33 source findings failed before implementation and zero remained afterward. The separate release review accounted for four more findings.
- Release automation publishes only `main.js`, `manifest.json` and `styles.css` and generates GitHub build-provenance attestations for those exact files.
- `npm run check` passed TypeScript, both ESLint configurations, all 717 tests across 35 files and the mobile-safe build. The dedicated property suite passed 100 tests; the public candidate audit scanned 142 files and both bundles with zero findings.
- Isolated Windows Obsidian 1.13.7 settings/branding validation passed three checks with zero console errors. Visual inspection caught and corrected declarative-setting host overflow, then confirmed normal vertical layout.
- The full V1 application lifecycle passed all 13 checks with zero console errors, including initialization, Push/Pull, conflict choice, deletion confirmation, new-device Bootstrap, interrupted-publication Recovery, read-only Verify, mobile execution and both explicit adoption authorities. Branch updates recorded no `force:true`.
- Public documentation and release copy use Stateful Git Sync as the product name and do not publish development-stage naming history. Technical plugin ID and state paths remain unchanged for data safety.

## 1.1.17

- Obsidian Community automated review first failed on three directory-compliance errors: the manifest description named Obsidian, two APIs exceeded the declared minimum app version, and Settings created a raw HTML heading. A branch preview then caught the additional rule that settings headings must not repeat the plugin name. The new regression assertions failed before the fixes and passed afterward.
- The implementation keeps `minAppVersion` at 1.6.0: SecretStorage is feature-detected with the established local-token fallback, Dashboard activation uses the compatible workspace API, and Settings uses a semantic `Synchronization` heading through `Setting.setHeading()`. Plugin identity, BASE, Manifest, Recovery and Three-Way Sync behavior are unchanged.
- `npm run check` passed TypeScript, ESLint, all 717 tests across 35 files and the mobile-safe build. The dedicated property suite passed 100 tests; the public candidate audit scanned 142 files and both bundles with zero findings.
- Isolated Windows Obsidian 1.13.7 branding validation passed Preview, Dashboard and Settings with zero console errors. Visual inspection confirmed the official Settings heading renders correctly. The full V1 suite passed all 13 lifecycle checks with zero console errors and no `force:true` branch update.
- The release ZIP contains exactly `main.js`, `manifest.json` and `styles.css` under the compatible `local-mirror-sync` directory. `stateful-git-sync-1.1.17.zip` SHA-256 is `dbb2dd5e7f5512ee0b89eba3f9dce64e733c2a80cfef357b59ac022b8e905af1`.

## 1.1.16

- Public-metadata compatibility RED first failed because the manifest did not yet use the final product name. The implementation changed only display/distribution metadata while retaining plugin ID `local-mirror-sync` and all state paths.
- `npm run check` passed TypeScript, ESLint, all 716 tests across 35 files and the mobile-safe build. The public candidate audit scanned 142 files and both bundles with zero findings.
- Isolated Windows Obsidian branding validation passed Preview, Dashboard and Settings with zero console errors. Visual inspection found no clipping or overflow from the longer name; reload preserved exact settings bytes, deviceId and BASE, and opening Dashboard made no GitHub request.
- The mobile keyboard suite passed every viewport/keyboard/safe-area bound with no overflow. The full V1 suite passed all 13 lifecycle checks with zero console errors, including 390px Push/Pull, conflict, delete, Bootstrap, Recovery and both Legacy Adoption authorities; branch updates recorded no `force:true`.
- The first full V1 launch overlapped the keyboard suite and correctly failed its isolated-Vault ownership assertion before reaching plugin logic. A serial rerun passed. Tests and generated Vaults never targeted the daily Vault.
- The release ZIP contains exactly `main.js`, `manifest.json` and `styles.css` under the compatible `local-mirror-sync` directory. SHA-256 verification passed; `stateful-git-sync-1.1.16.zip` is `4d1cdc504eac8acc71b2964cdead23df61863375d783a5e186f8901d405e7333`.

## 1.1.15

- Mobile confirmation RED reproduced the reported failure by asserting that instructions appear before keyboard focus and by simulating a native host rule that collapses the dialog to 64px.
- The corrected phone dialog retains a 380px minimum when space permits, keeps warning/phrase/input/actions inside its bounds, and remains contained under visual viewport shrink/pan, native keyboard height, combined signals and safe areas.
- `npm run check` passed all 716 tests across 35 files, TypeScript, ESLint and the mobile-safe build. The focused keyboard, Preview confirmation and complete V1 Obsidian suites passed with zero Console errors.
- Exact confirmation matching and all sync protocol semantics are unchanged. Physical iPhone installation remains a separate verification boundary.

## 1.1.13

- A new isolated Obsidian integration test first failed on the old Dashboard History section. After implementation it passed change-only Preview rows, ten-row pagination, deletion confirmation after Sync click, exact phrase/cancel safety, and the separate History view with zero Console errors.
- `npm run check` passed all 716 tests across 35 files, TypeScript, ESLint and the mobile-safe build. The read-only Preview, V1 execution, Dashboard, V1.1, mobile keyboard and legacy Recovery integration suites passed. The anonymous live GitHub read in the standalone Preview suite remained HTTP 403; its isolated fixture checks passed.
- Mobile keyboard emulation checked the new confirmation dialog under viewport shrink, native keyboard height and safe areas. The physical iPhone remains unverified.
- UI-only changes leave the three-way planner, delete threshold, Manifest, BASE and Recovery protocol intact.

## 1.1.12

- Empty-folder regression RED: four assertions failed before implementation (source parents remained, zero-change Sync did not repair leftovers, cleanup failure/concurrent-write safeguards never ran).
- All 716 tests across 35 files, TypeScript, ESLint and the mobile-safe build passed. Seven new service tests cover nested cleanup, completed-journal repair, ignored/occupied folders, recovery, concurrent additions and damaged/fallback journals.
- The isolated Windows Obsidian empty-folder suite passed six checks with zero console errors: actual disk/file-tree cleanup after remote rename and tombstone, zero-change upgrade repair without a new remote commit, hidden children, concurrent-child restoration and recovery. Mobile emulation used the production bundle.
- The existing V1 Obsidian integration suite passed with zero console errors, including initialization, Push/Pull, conflicts, deletion confirmation, bootstrap, restart recovery, read-only Verify and both Legacy Adoption choices.
- Desktop Obsidian's non-recursive rmdir rejected empty folders with EISDIR. The implementation therefore moves confirmed empty folders into transaction recovery and checks them again; it never recursively deletes a folder.
- Public candidate/bundle audit and diff whitespace checks passed. Tests used synthetic repositories and disposable Vaults. Physical iPhone installation and verification remain pending.

## 1.1.11

Changes: mobile file rows open a separate near-full-height dialog with independently scrolling content and visible Local/Remote actions; the main mobile Preview uses the available height. Conflict decisions can be applied individually or to all conflicts in the captured preview, including identity uncertainty. Selection only recompiles the plan; it never executes synchronization. Untracked local paths kept explicitly receive fresh identities, existing tombstones stay immutable, and no rename is inferred. Repository diagnostics and invalid destination paths still block execution.

- RED: the actual Obsidian mobile test reproduced inline details instead of an independent dialog. Seven initial service regressions failed on missing bulk/identity resolution before implementation.
- Service regressions cover both authorities, unrelated one-sided changes, unrecorded rename+edit, independent choices, stale HEAD, immutable tombstones, path swaps, ownership collisions and conflicting mixed choices.
- All 709 tests across 34 files, TypeScript, ESLint and the mobile-safe build passed. The final deletion-path regression also recorded RED before correcting the reviewed path.
- Mobile integration checks cover portrait/landscape, long content, fixed actions, comparison loading/error/retry, per-file and filtered bulk selection, Back/Escape and preserved desktop behavior. The suite uses a disposable Vault and synthetic remote; it does not change the user's notes.
- All 15 Obsidian suites passed their fixture checks (87 checks total). The original read-only Preview suite's optional anonymous GitHub probe remains HTTP 403 / `passed_with_live_read_pending`, independently of passing fixture checks. The other 14 suites passed with zero captured console errors.
- Existing mobile Preview tests now exercise the separate detail dialog. The Dashboard test waits for Obsidian's sidebar collapse to settle before the same overflow assertion; Dashboard product code is unchanged.
- Physical iPhone validation remains a user-device check; mobile dimensions and host mobile styles are exercised in the actual Windows Obsidian application.

## 1.1.10

Validated on 2026-09-20. Changes cover mobile keyboard visibility, repository-level blocked Preview UI, and explicit reviewed additive Manifest maintenance. Existing stable identities, tombstones and three-way resolution rules are unchanged.

- TypeScript, ESLint, production build and public-file/credential audit passed.
- All 694 unit/regression tests passed, including a regression that reproduces the invalid-plan `DELETE 37` prompt and verifies its removal.
- All 14 isolated Obsidian integration suites passed their fixture assertions (83 checks), with zero captured console errors in the final runs.
- The original Preview suite's optional anonymous public GitHub probe returned HTTP 403 and retains `passed_with_live_read_pending`; this is separate from its passing isolated assertions.
- Keyboard tests cover visual viewport shrink/pan, native keyboard height, both signals together, safe areas, dismissal, modal reopen, exact confirmation matching and desktop behavior. Physical iPhone keyboard testing remains pending.
- Blocked Preview tests cover invalid/missing Manifest and invalid local state, stale caller flags and malformed Manifest JSON. No executable plan, synthetic operation counts or deletion confirmation are shown for repository-level errors.
- Maintenance tests cover explicitly reviewed additions, preserving identical-content files as separate identities, existing-BASE sync and empty-device Bootstrap, wrong SHA, missing/extra review, identity reuse, missing tracked paths, backups, stale HEAD, candidate verification and idempotent retries.
- RED evidence was recorded before each fix. Review/repair guidance was then shared between parsed blocked plans and Manifest read failures.
- The lifecycle UI harness now waits for the sidebar collapse layout before enforcing the unchanged overflow assertion; Dashboard product behavior was not changed.

## 1.1.9

Validated on 2026-09-20 with Node.js 24.16.0, npm 11.13.0 and Windows Obsidian 1.13.7. This release changes branding and publication packaging; the runtime diff from the previous stable source is eight string replacements across six files. No ID migration, storage-path change, dependency upgrade or synchronization-rule change was made.

## Automated checks

| Check | Result |
| --- | --- |
| TypeScript typecheck | Pass |
| ESLint | Pass |
| Unit / regression suite | 33 files, 684 tests passed, including 4 new branding/compatibility cases |
| Dedicated property suite | 100 tests passed (also included in the full suite) |
| Production build | Pass; Obsidian is the only external runtime dependency |
| Clean public-source install | `npm ci` and `npm run check` passed without private/generated files; npm reported 0 vulnerabilities |
| Public-file and bundle scan | No credential/private-path findings in the publication set |
| Install package | Exactly three runtime files under the compatible plugin directory; ZIP entries and SHA-256 checked |

The regression suite was run before the public metadata update: the display-name assertion failed while three compatibility cases passed. After the minimal update, all four passed. It covers existing SecretStorage/fallback credentials, BASE/device identity, Manifest and interrupted Recovery across reload in default and custom config directories.

## Real application integration

All 13 integration suites completed their fixture checks, totaling **80 checks**. Final suite runs recorded zero console errors:

| npm script | Checks |
| --- | ---: |
| `test:obsidian` | 14 |
| `test:obsidian:v1` | 13 |
| `test:obsidian:v11` | 6 |
| `test:obsidian:v111` | 6 |
| `test:obsidian:v112` | 7 |
| `test:obsidian:v113` | 11 |
| `test:obsidian:v114` | 3 |
| `test:obsidian:activity` | 6 |
| `test:obsidian:lifecycle` | 2 |
| `test:obsidian:dashboard` | 4 |
| `test:obsidian:publish` | 3 |
| `test:obsidian:manifest` | 2 |
| `test:obsidian:brand` | 3 |

The original Preview suite explicitly disabled its optional public GitHub live read with `LMS_SKIP_LIVE_GITHUB=1`, so it reports `passed_with_live_read_pending`; all 14 fixture checks passed. The V1.1 suite initially reported three stackless `illegal access` page errors around a Settings popout close. An unchanged rerun passed with zero console errors; the first failure remains in local evidence and was not filtered out. No production workaround was added for that intermittent result.

The suites use isolated synthetic Vaults, fresh profiles and local HTTP GitHub fixtures. They exercise loading/empty states, Preview, settings, Auto Sync, initialization/adoption, conflict handling, Verify, Recovery, interrupted publication, reload, local history and Dashboard caching. Desktop branding screenshots and 390px activity/Dashboard screenshots were visually reviewed. The branding integration confirms original command IDs and persisted settings/BASE survive a production plugin reload.

## Publication audit

Only reviewed source, synthetic tests/generators, maintained documentation and build/CI metadata are included. The old local reports and operational scripts referencing a personal Vault are preserved locally and excluded. Test profiles, real/private artifacts, transaction/recovery data, generated Vaults and dependency directories are excluded as well.

A broader local credential-pattern pass covered 13,025 project files outside dependency/Git/bundle archives without finding a GitHub token or private key. Assignment-like strings in public tests were manually checked: they are inert synthetic fixtures, not usable credentials. Scanners report paths/rules only and do not print matched secrets. Automated scanning supplements review; it is not a proof that arbitrary future files are safe.

## Acceptance limits

Physical iPhone/Android tests and real multi-device synchronization against a private notes repository were not performed for this release. Mobile evidence is bundle validation and Obsidian emulation. Publishing the plugin's source and release assets to GitHub is a separate operation and does not establish live note-sync acceptance. No personal Vault was installed into or changed by these checks.
