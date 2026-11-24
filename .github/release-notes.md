Stateful Git Sync **1.2.3** improves recovery from temporary errors while downloading individual files.

### Changes

- A timed-out blob read, connection error or transient server error triggers one retry of that file within the current sync.
- Larger supported attachments receive a longer read deadline based on their size. The initial GitHub branch check still has a 10-second deadline.
- Subsequent attempts reuse recovery copies after verifying their content hashes. Download failures report the affected file path when it is known.

### Validation and upgrade

Validated with the project test suite, property tests, type checking, lint, the release build, and an isolated 540-file Obsidian Vault. Tests covered a blob reaching its deadline, a larger attachment completing after 30 seconds, reuse after a restart, and a real Obsidian sync recovering from a simulated transfer timeout.

Update through Community plugins or replace the three release assets in the existing plugin folder.

### 中文说明

- 同步途中某个文件超时、断线或遇到临时服务错误时，当前任务会自动补试该文件一次。
- 较大的附件按大小获得更长的读取时间。再次同步时可复用通过哈希校验的已下载副本。
- 下载失败时会尽可能显示具体文件路径。
