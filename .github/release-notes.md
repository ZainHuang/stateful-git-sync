Fixes Preview stuck at **Preparing Preview** during mobile Vault startup. New-file tracking now begins after the workspace is ready, so existing-file startup announcements no longer queue unnecessary identity/cache writes. Real create, rename and delete events remain tracked.

Preview shows whether it is waiting for local identity updates, dashboard updates or pending Recovery. These waits and GitHub GET requests have a 30-second deadline and respond to cancellation. Late read responses cannot resume a timed-out caller; an error offers **Retry Preview**. Pending metadata and recovery files are retained. BASE, Manifest, explicit conflict choices and publication/recovery safety rules are unchanged.

修复安卓启动后长时间停在 **Preparing Preview** 的问题：避免把启动加载的已有文件当作新建事件反复保存状态，显示具体等待阶段，并为本地状态等待和 GitHub 读取增加 30 秒超时与取消响应。出错后可点击 **Retry Preview** 重试；原有文件身份、冲突选择和恢复保护保持不变。

Validation: all **759 tests**, TypeScript, standard and Obsidian lint, and the mobile-safe build passed. Isolated real Obsidian startup/timeout checks and all 13 V1 lifecycle checks passed with zero Console errors, including the 390px mobile viewport. Physical Android verification remains pending.
