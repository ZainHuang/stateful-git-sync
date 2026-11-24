import { DEFAULT_READ_TIMEOUT_MS, PreviewError, readWithTimeout } from '../errors';
import { gitBlobSha } from '../vault/HashService';
import { isRecord, isSha } from '../sync/manifest/ManifestValidator';
import { GitHubClient } from './GitHubClient';
import type { GitTransport, RepositoryTarget } from './types';
import { decodeBytes, encodeBytes } from './BinaryCodec';
import type { SyncPerformance } from '../product/SyncPerformance';
export { decodeBytes, encodeBytes } from './BinaryCodec';

// Bound memory use on iPhone; larger attachments must be excluded explicitly.
export const MAX_SYNC_FILE_BYTES = 20 * 1024 * 1024;
const BLOB_DOWNLOAD_RETRY_DELAY_MS = 1_000;
const BLOB_DOWNLOAD_BYTES_PER_SECOND = 256 * 1024;
const failed = (code: string) => new PreviewError('GITHUB_SYNC', code, 'GitHub sync could not be verified. Recovery data is retained; refresh or resume the transaction.');
export type PublishEvent = { at: string } & (
  { kind: 'commit-created'; commit: string }
  | { kind: 'patch-request'; expectedHead: string; commit: string; ref: string; force: false }
  | { kind: 'patch-response'; status: 200; commit: string; ref: string }
  | { kind: 'read-back' | 'recovery-head'; head: string }
);
export class GitHubWriter {
  readonly reader: GitHubClient;
  constructor(private readonly target: RepositoryTarget, private readonly token: string, private readonly transport: GitTransport, private readonly measurement?: SyncPerformance) {
    this.reader = new GitHubClient(target, token, transport);
  }
  async head(signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    const value = await this.reader.get(`ref/heads/${this.target.branch.split('/').map(encodeURIComponent).join('/')}`, 'REMOTE_REF', signal, timeoutMs);
    if (!isRecord(value) || value.ref !== `refs/heads/${this.target.branch}` || !isRecord(value.object) || value.object.type !== 'commit' || !isSha(value.object.sha)) throw failed('INVALID_REF');
    return value.object.sha;
  }
  async download(sha: string, { expectedSize, signal }: { expectedSize?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (expectedSize !== undefined && expectedSize > MAX_SYNC_FILE_BYTES) throw failed('FILE_TOO_LARGE');
    // Budget for Base64 transfer over a slow mobile connection plus request overhead.
    const encodedSize = Math.ceil((expectedSize ?? 0) / 3) * 4;
    const timeoutMs = Math.max(DEFAULT_READ_TIMEOUT_MS, (10 + Math.ceil(encodedSize / BLOB_DOWNLOAD_BYTES_PER_SECOND)) * 1_000);
    const read = () => this.reader.get(`blobs/${sha}`, 'REMOTE_BLOB', signal, timeoutMs);
    let value: unknown;
    try { value = await read(); }
    catch (error) {
      // This GET addresses immutable bytes. Permissions, rate limits and writes use their existing handling.
      if (!(error instanceof PreviewError) || !/^(NETWORK_(ERROR|TIMEOUT)|HTTP_(408|5\d{2}))$/.test(error.code)) throw error;
      const timerWindow = typeof window === 'undefined' ? { setTimeout } : window;
      await readWithTimeout(() => new Promise<void>(resolve => { timerWindow.setTimeout(resolve, BLOB_DOWNLOAD_RETRY_DELAY_MS); }), 'REMOTE_BLOB', signal);
      value = await read();
    }
    if (!isRecord(value) || value.sha !== sha || value.encoding !== 'base64' || typeof value.content !== 'string'
      || typeof value.size !== 'number' || value.size > MAX_SYNC_FILE_BYTES || value.content.length > MAX_SYNC_FILE_BYTES * 1.5
      || (expectedSize !== undefined && value.size !== expectedSize)) throw failed('INVALID_BLOB');
    let bytes: Uint8Array;
    try { bytes = decodeBytes(value.content); } catch { throw failed('INVALID_BLOB'); }
    if (bytes.length !== value.size || gitBlobSha(bytes, this.measurement) !== sha) throw failed('BLOB_HASH_MISMATCH');
    return bytes;
  }
  async upload(bytes: Uint8Array): Promise<string> {
    if (bytes.length > MAX_SYNC_FILE_BYTES) throw failed('FILE_TOO_LARGE');
    const sha = await this.create('blobs', { content: encodeBytes(bytes), encoding: 'base64' });
    if (sha !== gitBlobSha(bytes, this.measurement)) throw failed('BLOB_HASH_MISMATCH');
    return sha;
  }
  async create(resource: 'blobs' | 'trees' | 'commits', body: Record<string, unknown>): Promise<string> {
    const value = await this.write('POST', resource, body);
    if (!isRecord(value) || !isSha(value.sha)) throw failed('INVALID_OBJECT');
    return value.sha;
  }
  async publish(commit: string, expectedHead: string, checkpoint?: (event: PublishEvent) => Promise<void>): Promise<void> {
    if (await this.head() !== expectedHead) throw failed('REMOTE_HEAD_CHANGED');
    const ref = `refs/heads/${this.target.branch}`;
    await checkpoint?.({ kind: 'patch-request', at: new Date().toISOString(), expectedHead, commit, ref, force: false });
    const value = await this.write('PATCH', `refs/heads/${this.target.branch.split('/').map(encodeURIComponent).join('/')}`, { sha: commit, force: false });
    if (!isRecord(value) || value.ref !== `refs/heads/${this.target.branch}` || !isRecord(value.object)
      || value.object.type !== 'commit' || value.object.sha !== commit) throw failed('PUBLISH_RESPONSE_UNCERTAIN');
    await checkpoint?.({ kind: 'patch-response', at: new Date().toISOString(), status: 200, commit: value.object.sha, ref: value.ref });
    const head = await this.head();
    await checkpoint?.({ kind: 'read-back', at: new Date().toISOString(), head });
    if (head !== commit) throw failed('PUBLISH_READBACK_UNCERTAIN');
  }
  async backup(ref: string, expectedHead: string): Promise<void> {
    if (await this.head() !== expectedHead) throw failed('REMOTE_HEAD_CHANGED');
    const value = await this.write('POST', 'refs', { ref, sha: expectedHead });
    this.checkBackup(value, ref, expectedHead);
    await this.verifyBackup(ref, expectedHead);
  }
  async verifyBackup(ref: string, expectedHead: string): Promise<void> {
    if (!/^refs\/heads\/local-mirror-sync-backup\/[a-f0-9-]{36}$/.test(ref)) throw failed('INVALID_BACKUP_REF');
    const value = await this.reader.get(`ref/${ref.slice(5)}`, 'VERIFY_BACKUP');
    this.checkBackup(value, ref, expectedHead);
  }
  private checkBackup(value: unknown, ref: string, sha: string): void {
    if (!isRecord(value) || value.ref !== ref || !isRecord(value.object) || value.object.type !== 'commit' || value.object.sha !== sha) throw failed('BACKUP_VERIFY_FAILED');
  }
  async contains(commit: string, head: string): Promise<boolean> {
    const queue = [head]; const seen = new Set<string>();
    for (let i = 0; i < queue.length && i < 500; i++) {
      const sha = queue[i]!; if (sha === commit) return true; if (seen.has(sha)) continue; seen.add(sha);
      const value = await this.reader.get(`commits/${sha}`, 'VERIFY_HISTORY');
      if (!isRecord(value) || value.sha !== sha || !Array.isArray(value.parents)) throw failed('INVALID_HISTORY');
      for (const parent of value.parents) { if (!isRecord(parent) || !isSha(parent.sha)) throw failed('INVALID_HISTORY'); queue.push(parent.sha); }
    }
    if (queue.length > 500) throw failed('HISTORY_LIMIT');
    return false;
  }
  private async write(method: 'POST' | 'PATCH', resource: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.token) throw failed('TOKEN_REQUIRED');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Stateful-Git-Sync/1.1.18', 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
    try {
      const response = await this.transport({ url: `https://api.github.com/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repository)}/git/${resource}`,
        method, headers, body: JSON.stringify(body), throw: false });
      if (response.status !== (method === 'POST' ? 201 : 200)) throw failed(`HTTP_${response.status}`);
      return response.json;
    } catch (error) { if (error instanceof PreviewError) throw error; throw failed('NETWORK_UNCERTAIN'); }
  }
}
