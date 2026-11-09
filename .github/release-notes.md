Stateful Git Sync **1.2.1** improves editing during synchronization and keeps automatic sync retryable after temporary failures.

### Changes

- Eligible, conflict-free uploads publish a verified frozen snapshot. Edits made after staging stay local and are queued for a later sync. Changes during the initial scan may still require a fresh Preview.
- When no transaction is pending, automatic sync retries recoverable local-change errors, temporary network failures, timeouts and supported rate-limit or server errors after the configured delay. The activity view shows the retry countdown, including after a restart when a retry was pending.
- Ordinary content edits excluded by the plugin's Ignore Patterns do not invalidate an eligible scan. Create, delete and rename events remain tracked for file identity history.
- Index lookups and ordinary index writes are more efficient. Technical details now show operation-level timings for Preview and execution.
- Downloads, conflicts, deletion thresholds and pending Recovery retain their existing safeguards and review requirements. Automatic retry does not resolve conflicts or resume a retained transaction.

### Validation and upgrade

TypeScript, both lint configurations, the project test suite, property tests, the mobile-compatible build and the public-content audit were run before release. An isolated Windows Obsidian test used a local GitHub fixture to check snapshot uploads, queued edits, retry, Recovery protection and desktop/mobile-sized layouts. Mobile layouts were emulated; physical iOS and Android devices and a live notes repository were not part of this release validation.

Update through Community plugins, or replace `main.js`, `manifest.json` and `styles.css` in the existing `local-mirror-sync` plugin folder. Preserve settings, BASE and pending Recovery. The first check after reload performs full reconciliation.

### 中文说明

**1.2.1** 为符合条件的无冲突上传使用已验证的冻结快照；快照准备后的本地编辑保留并进入后续同步。没有待恢复事务时，扫描期间的本地变化、临时网络故障、超时及受支持的限流或服务端错误，会按自动同步间隔重试，面板显示倒计时。忽略规则排除的普通内容编辑不会干扰当前扫描；文件身份相关的新增、删除、重命名事件仍会记录。下载、冲突、删除阈值和待恢复事务继续使用原有保护。
