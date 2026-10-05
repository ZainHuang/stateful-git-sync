# Stateful Git Sync changelog

## 1.1.21 - Recovery and Preview loop

- Pending Recovery no longer offers a Preview button after `RECOVERY_ENV_CHANGED`; the error explains that recovery or a safe Abort must finish first.
- Recovery reports target, device identity, branch history and backup verification failures, retaining the underlying backup error code. Network errors during Resume retain their error codes and direct retries to Resume.
- Confirmed published adoption with no local writes can verify its original commit and backup after the branch advances to a descendant, complete that snapshot's BASE and preserve later edits for the next normal Preview. Unconfirmed adoption and adoption with local writes retain the exact-HEAD requirement.

## 1.1.20 - English default and repository rename

- Rename the GitHub repository to `ZainHuang/stateful-git-sync` and update installation, issue and package links.
- Make the complete English guide the default `README.md`; preserve the Chinese guide in `README.zh-CN.md`.
- Lead both guides with the stateful multi-device consistency model and its differences from workflows centered on Git pull/push and text merge.
- Use an English description in the release manifest and package metadata. Plugin ID, stored state, permissions and sync behavior remain unchanged.

## 1.1.19 - Bilingual public description

- Added direct Chinese and English navigation with equivalent summaries to the Community and GitHub README.
- Updated the plugin manifest and GitHub repository description with concise bilingual copy.
- Sync protocol, stored data, permissions and runtime behavior are unchanged.

## 1.1.18 - Initial community release hardening

- Cleared the current Obsidian automated-review findings without changing BASE, Manifest, Three-Way Sync, conflict, Recovery or verification behavior.
- Added searchable settings definitions while retaining the established settings UI on Obsidian 1.6.0 and later.
- Release automation now publishes only `main.js`, `manifest.json` and `styles.css`, with GitHub build-provenance attestations for the exact files.
- Public installation and release copy now presents Stateful Git Sync as a first-release product and omits development-stage naming history.

## 1.1.17 - Community directory compliance

- Removed the redundant product name from the directory description and changed the Settings section title to the official `Setting.setHeading()` API without repeating the plugin name.
- Preserved support for Obsidian 1.6.0 by feature-detecting SecretStorage and using the established local-token fallback on older clients.
- Replaced the newer `Workspace.revealLeaf()` call with the compatible active-leaf API. Plugin identity, sync protocol, persisted state and user workflows are unchanged.

## 1.1.16 - Public metadata finalization

- Finalized the unique Stateful Git Sync display name for the Obsidian community directory.
- Updated Settings, Preview, Dashboard, command prefixes, activity labels, future sync commit messages, documentation and release packaging to use the public name consistently.
- Kept Obsidian plugin ID `local-mirror-sync`, installation folder, command/view IDs, SecretStorage references, deviceId, BASE, Manifest, Recovery and Three-Way Sync behavior unchanged.

## 1.1.15 - Larger mobile confirmation dialog

- Destructive-action confirmations now open as a substantially larger phone dialog instead of collapsing to a title-only strip under native mobile modal styles.
- On phones, the instructions are shown before the software keyboard opens. After the user taps the input, the warning, exact phrase, field and actions remain inside the keyboard-visible viewport and safe areas.
- Desktop confirmation remains keyboard-first. Exact `DELETE N`, `USE LOCAL` and `USE REMOTE` matching, deletion thresholds, Preview, BASE, Manifest, Recovery and Three-Way Sync behavior are unchanged.

## 1.1.14 — Correct plugin author

- Obsidian plugin author is now shown as ZainHuang. Sync behavior and stored data are unchanged.

## 1.1.13 — Focused Preview and confirmation dialog

- Preview lists only Push, Pull and Conflict decisions, ten per page. Unchanged files remain in the plan for verification but are omitted from the displayed rows and category buttons.
- Clicking **Sync & Verify** now opens a separate dialog for exact `DELETE N` confirmation when the existing threshold requires it. Legacy **Adopt & Verify** collects its `USE LOCAL` / `USE REMOTE` phrase in the same way. Cancel leaves Preview intact and performs no sync.
- Dashboard no longer repeats recent History records at the bottom. The dedicated Sync History view and its button remain available.
- File decisions, deletion thresholds, BASE, Manifest, Recovery and Three-Way Sync semantics are unchanged.

## 1.1.12 — Old empty directory cleanup

- Sync now removes empty source directories after file moves/deletions, deepest first. Recorded old paths in completed local transaction journals also allow a subsequent zero-file-change Sync to clean leftovers from earlier versions.
- Cleanup moves empty directories into the transaction recovery area; it never recursively deletes them. Concurrent children are restored or retained in recovery, and cleanup errors prevent success/BASE finalization.
- Unrelated empty directories, hidden/internal directories, ignored or excluded paths, and directories with any remaining children are preserved. Missing or damaged history does not authorize broad empty-folder deletion.
- File identity, three-way resolution, Manifest format and file verification are unchanged. Preview and standalone Verify remain read-only.

## 1.1.10 — Blocked-plan diagnostics and mobile confirmation

- Repository-level blocked previews show diagnostics and review/repair guidance, with Sync disabled and no synthetic operation counts or deletion confirmation.
- Deletion impact and confirmation are available only for executable plans above the configured threshold.
- Explicit maintenance supports exactly reviewed additive Manifest registrations with new identities, verified backup refs, unchanged user Trees and candidate verification before publication. Preview never repairs a Manifest automatically.
- Mobile confirmation dialogs adapt to the keyboard-visible viewport and native keyboard height, scroll the focused field/actions into view, and respect safe areas.
- Three-way resolution, existing stable identities and tombstones retain their existing semantics.

## 1.1.9 — Initial public build

- Established the initial display name, settings, Preview, Dashboard, command prefix, activity labels, commit messages and distribution metadata.
- Kept Obsidian plugin ID `local-mirror-sync`, existing command/view IDs, SecretStorage references, state paths, Manifest and Recovery formats. No ID or data migration.
- Published user installation/setup/recovery documentation, MIT license, reproducible build instructions, public-file audit and CI.
- Includes Stateful BASE / LOCAL / REMOTE Three-Way Sync, stable file identity, tombstone deletion and rename propagation, conflict protection, initialization/adoption, verified GitHub publication and Recovery.
- Includes safe event-driven Auto Sync (default OFF), cached Dashboard, local Sync History, device reports and activity status.
- Retains the existing stable 1.1.9 Dashboard refresh fix and all prior sync/recovery behavior. Public metadata does not change synchronization semantics.

Release assets included the three Obsidian runtime files and development packaging artifacts.
