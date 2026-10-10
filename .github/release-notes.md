Stateful Git Sync **1.2.0** adds incremental sync and smart verification to the existing Three-Way Sync executor. Daily sync reads dirty files and a rotating integrity sample, reuses verified unchanged hashes, and caches validated immutable Commit/Tree/Manifest metadata. Remote branch HEAD is still checked freshly for concurrency.

**Incremental Verified** strictly verifies changed bytes, deletion/rename results, remote metadata and BASE read-back. **Full Integrity Verified** additionally audits every eligible local file. Initialization, plugin restart, mobile resume, untrusted or damaged caches, scope changes, standalone Verify and Recovery with local writes require full reconciliation. Full audits also run after 24 hours or 20 sync cycles. Missed events with unchanged size/timestamps are detected by rotating byte samples and scheduled full audits, rather than treating metadata as permanent content proof.

Sync events received during execution remain dirty for the next review. Verification failure retains Recovery and the previous BASE. Existing conflict choices, Tombstones, safe deletion, atomic GitHub publication and `force:false` remain in place; Manifest semantics and the sync executor are preserved.

The panel and corner activity indicator share the existing status events. Default progress is **检查差异 → 同步文件 → 安全校验** (check differences → sync files → safety verification), with actual file counts and elapsed time. Technical stages and diagnostics expand on demand. Completed sync shows a static verification result; subsequent edits reset the live status to pending changes.

### Performance evidence

Three sequential paired runs used a synthetic 540-file disk Vault (500 Markdown files and 40 attachments), the production SyncService and a local HTTP GitHub fixture. Values below are medians; they are not live GitHub or physical-phone timings.

| Scenario | Before → 1.2.0, ms | Content/payload hash bytes | Content reads | API requests |
| --- | ---: | ---: | ---: | ---: |
| Initialization | 2,988.7 → 3,702.5 | 64,888,414 → 38,997,094 | 3,780 → 1,620 | 561 → 557 |
| No changes | 2,288.5 → 403.8 | 51,782,640 → 524,288 | 3,240 → 8 | 12 → 6 |
| Edit 1 file | 2,612.8 → 666.3 | 58,446,538 → 753,801 | 3,780 → 11 | 24 → 17 |
| Edit 10 files | 2,646.6 → 703.9 | 58,725,369 → 1,378,557 | 3,780 → 38 | 42 → 35 |
| Rename 25 files | 3,135.4 → 771.0 | 58,802,264 → 2,032,302 | 3,780 → 83 | 47 → 40 |
| Mixed Push/Pull Recovery | 520.8 → 625.8 | 6,465,409 → 6,465,409 | 541 → 541 | 7 → 7 |

Daily scenarios reduced elapsed time by **73.4–82.4%**. Initialization increased **23.9%** and full Recovery increased **20.2%**; both retain full verification. Hash counts cover instrumented content and upload payloads; internal metadata checksum accounting is separate and is not directly comparable with the old baseline.

### Validation and installation

All **825 tests**, TypeScript, standard and Obsidian lint, the mobile-safe build and the dedicated **100-case property suite** passed locally. Nineteen isolated real Windows Obsidian suites passed **112 checks** with zero captured Console errors. iOS/Android viewport, keyboard and lifecycle checks use desktop emulation; physical devices and live notes-repository sync remain unverified. Tests did not modify a personal Vault.

Update by disabling the plugin and replacing `main.js`, `manifest.json` and `styles.css` in the existing `local-mirror-sync` plugin folder, then enable it. Preserve settings, BASE and pending Recovery. The first sync after reload performs full reconciliation.

中文：V1.2 新增持久化变更索引、可信 Hash/远端元数据复用和智能验证，日常仅读取变化文件与轮换审计样本。界面默认显示「检查差异 → 同步文件 → 安全校验」，技术过程可展开。明确区分增量验证与全量完整性验证；初始化、重启、移动端恢复、缓存异常及需要本地写入的 Recovery 回退全量。540 文件隔离基准中日常同步耗时降低 73.4–82.4%；初始化和完整 Recovery 耗时分别增加 23.9% 与 20.2%。保留现有冲突、删除、Manifest、BASE 和恢复安全规则。
