Stateful Git Sync **1.2.2** checks GitHub before scanning and keeps confirmed syncs running after the progress window closes.

### Changes

- Preview checks the configured GitHub repository and branch before scanning the Vault. An unresponsive connection check times out after 10 seconds and offers Retry Preview.
- **Sync & Verify** rechecks the branch before rescanning a reviewed plan. The sync progress window can be closed while the confirmed operation continues. Reopen Sync activity from the ribbon to see progress or the result.
- If an app visibility change invalidates the local index during verification, the plugin runs a fresh check. File changes still follow the existing verification and Recovery rules.

### Validation and upgrade

Validated with the full test suite, property tests, type checking, lint, the release build, and isolated Obsidian on Windows with mobile-sized layouts and a GitHub fixture. Physical Android devices were outside this validation. Android can suspend Obsidian when the whole app is backgrounded.

Update from Community plugins. For a manual upgrade, replace the three release assets in the existing plugin folder.

### 中文说明

- 先检查 GitHub 仓库和目标分支，成功后再扫描本地笔记和附件。连接检查最多等待 10 秒，失败可重试。
- 确认同步后可关闭窗口并返回笔记，进度可从侧栏的同步图标查看。应用切回时若索引失效，插件会重新校验。
