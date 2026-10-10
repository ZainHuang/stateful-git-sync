import type { ActivityStage } from '../product/SyncActivity';
import { assertActive, PreviewError } from '../errors';
import { GitHubClient } from '../github/GitHubClient';
import { RemoteTreeReader } from '../github/RemoteTreeReader';
import type { GetTransport } from '../github/types';
import { IgnoreService } from '../vault/IgnoreService';
import { VaultScanner, type Progress, type VaultReader } from '../vault/VaultScanner';
import type { PreviewOptions } from './PreviewService';
import type { SyncPerformance } from '../product/SyncPerformance';
import type { LocalChangeIndex } from '../vault/LocalChangeIndex';
import type { RemoteMetadataCache } from '../github/RemoteMetadataCache';

/** Shared read/verify boundary; both planners consume exactly the same scanner rules. */
export class PreviewSnapshotReader {
  constructor(private readonly reader: VaultReader, private readonly transport: GetTransport, private readonly configDir: string, private readonly measurement?: SyncPerformance,
    private readonly index?: LocalChangeIndex, private readonly remoteCache?: RemoteMetadataCache, private readonly forceFull = false) {}
  private async readGitignore(): Promise<string> {
    try {
      const stat = await this.reader.stat('.gitignore');
      if (!stat) return '';
      if (stat.type !== 'file') throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(await this.reader.readBinary('.gitignore'));
    } catch { throw new PreviewError('IGNORE', 'READ_FAILED', 'The root .gitignore could not be read as UTF-8. No plan was created.'); }
  }
  async read(options: PreviewOptions, token: string, progress: Progress, signal?: AbortSignal, stage: (stage: ActivityStage, processed?: number, total?: number) => void = () => {}) {
    const client = new GitHubClient(options, token, this.transport);
    assertActive(signal); progress('Reading ignore rules');
    const gitignore = await this.readGitignore();
    const ignore = new IgnoreService({ includeObsidian: options.includeObsidian, patterns: options.ignorePatterns, gitignore, configDir: this.configDir });
    const scanner = new VaultScanner(this.reader, this.measurement);
    const scopeKey = JSON.stringify({ configDir: this.configDir, includeObsidian: options.includeObsidian, patterns: options.ignorePatterns, gitignore });
    const cache = this.index ? { index: this.index, scopeKey, forceFull: this.forceFull } : undefined;
    stage('Scan local');
    progress('Scanning local Vault');
    const local = await scanner.scan(ignore, progress, signal, [], (processed, total) => stage('Scan local', processed, total), cache ? { ...cache, audit: true } : undefined);
    if (local.verification === 'full') this.remoteCache?.clear();
    stage('Read remote');
    const remote = await new RemoteTreeReader(client, this.remoteCache).read(options.branch, progress, signal);
    const verify = async () => {
      progress('Rechecking local content for changes');
      // Initial Scan and final Verify reconcile metadata. These checkpoints use
      // the live event watermark plus complete inventories and dirty byte reads.
      const checked = await scanner.scan(ignore, progress, signal, [], undefined, cache ? { ...cache, metadataCheck: false } : undefined);
      // Only eligible bytes define a snapshot. Internal/history/workspace writes,
      // ignored additions and protected directory creation never stale the ticket.
      const comparable = (snapshot: typeof local) => snapshot.files;
      if (gitignore !== await this.readGitignore() || JSON.stringify(comparable(local)) !== JSON.stringify(comparable(checked))) {
        throw new PreviewError('LOCAL_SCAN', 'LOCAL_CHANGED', 'Vault or ignore rules changed during Preview. Run Preview again.');
      }
      if (checked.verification === 'full') local.verification = 'full';
      assertActive(signal);
    };
    return { client, local, remote, ignore, gitignore, verify };
  }
}
