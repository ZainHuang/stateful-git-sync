import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, stat, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..'); process.chdir(root);
const artifacts = join(root, 'artifacts/v12'); await mkdir(artifacts, { recursive: true });
const reuseBaseline = process.argv.includes('--use-baseline');
const baseline = process.argv.includes('--baseline') || reuseBaseline; const label = baseline ? 'baseline' : 'optimized';
const modulePath = join(artifacts, `${label}.mjs`);
if (baseline && !reuseBaseline) { try { await stat(modulePath); throw new Error('Baseline is immutable; use the existing artifact'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
if (!reuseBaseline) await build({ entryPoints: ['scripts/v12-benchmark-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: modulePath });
const runtime = await import(pathToFileURL(modulePath).href);
const { SyncService, LocalStateStore, GitFixture, gitBlobSha } = runtime;
const options = { owner: 'test-owner', repository: 'test-repository', branch: 'main', includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 100 };
const utf8 = s => new TextEncoder().encode(s);
class DiskVault {
  reads = []; index; measurement;
  constructor(directory) { this.directory = directory; }
  path(path) { const result = resolve(this.directory, path); assert(!relative(this.directory, result).startsWith('..')); return result; }
  async list(path) {
    const entries = await readdir(this.path(path), { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const prefix = path ? `${path}/` : '';
    return { files: entries.filter(e => e.isFile()).map(e => prefix + e.name), folders: entries.filter(e => e.isDirectory()).map(e => prefix + e.name) };
  }
  async stat(path) { try { const s = await stat(this.path(path)); return { type: s.isFile() ? 'file' : 'folder', size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async readBinary(path) { this.reads.push(path); const b = await readFile(this.path(path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async readInternal(path) { try { return await readFile(this.path(path), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async writeInternal(path, text) { await mkdir(dirname(this.path(path)), { recursive: true }); await writeFile(this.path(path), text); }
  async removeInternal(path) { await unlink(this.path(path)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  async removeEmptyFolder(path, recovery) {
    if ((await this.stat(path))?.type !== 'folder') return;
    const listing = await this.list(path); if (listing.files.length || listing.folders.length) return;
    const destination = `${recovery}/${crypto.randomUUID()}`; await mkdir(dirname(this.path(destination)), { recursive: true }); await rename(this.path(path), this.path(destination));
  }
  async edit(path, data) { await mkdir(dirname(this.path(path)), { recursive: true }); await writeFile(this.path(path), data); this.index?.record('modify', path); }
  async move(from, to) { await mkdir(dirname(this.path(to)), { recursive: true }); await rename(this.path(from), this.path(to)); this.index?.record('rename', to, from); }
  async apply(path, data, expected, recovery) {
    const before = await this.stat(path); const current = before ? new Uint8Array(await this.readBinary(path)) : null;
    if (current) this.measurement?.localRead(current.byteLength);
    const actual = current ? gitBlobSha(current, this.measurement) : null; const desired = data ? gitBlobSha(data, this.measurement) : null;
    if (actual === desired) return;
    if (actual !== expected) throw new Error('Concurrent local edit; bytes retained');
    if (current) { await mkdir(dirname(this.path(recovery)), { recursive: true }); await rename(this.path(path), this.path(recovery)); }
    if (data) { await mkdir(dirname(this.path(path)), { recursive: true }); await writeFile(this.path(path), data, { flag: 'wx' }); }
    this.index?.record(data ? 'modify' : 'delete', path);
  }
}
async function fixtureDevice(remote, directory, files = {}, indexed = true) {
  await mkdir(directory, { recursive: true }); const vault = new DiskVault(directory);
  for (const [path, content] of Object.entries(files)) await vault.edit(path, content);
  const statePath = '.obsidian/plugins/local-mirror-sync/sync-state.json';
  const state = new LocalStateStore({ read: () => vault.readInternal(statePath), write: s => vault.writeInternal(statePath, s) }); await state.load();
  let index;
  if (runtime.LocalChangeIndex && indexed) {
    const p = '.obsidian/plugins/local-mirror-sync/local-change-index.json';
    index = new runtime.LocalChangeIndex({ read: () => vault.readInternal(p), write: s => vault.writeInternal(p, s) }); await index.load(); vault.index = index;
  }
  const service = new SyncService(vault, remote.transport, '.obsidian', state, undefined, index);
  vault.measurement = service.performance;
  const run = async () => {
    const start = performance.now(); const preview = await service.preview(options, 'fixture-token-only'); const scan = service.performanceSnapshot();
    await service.execute(preview, 'fixture-token-only'); const execute = service.performanceSnapshot();
    const metrics = {};
    for (const key of ['localReads', 'localReadBytes', 'internalReads', 'internalReadBytes', 'hashCalls', 'hashBytes', 'metadataHashBytes', 'apiRequests', 'apiRequestBytes', 'apiResponseBytes', 'statCalls', 'listCalls', 'reusedHashes', 'cacheHits']) metrics[key] = (scan[key] ?? 0) + (execute[key] ?? 0);
    metrics.stages = Object.fromEntries(Object.keys(scan.stages).map(key => [key, Object.fromEntries(Object.keys(scan.stages[key]).map(field => [field, scan.stages[key][field] + execute.stages[key][field]]))]));
    return { elapsedMs: performance.now() - start, ...metrics, verification: execute.verification, reconciliations: [...new Set([...scan.reconciliations, ...execute.reconciliations])] };
  };
  return { vault, state, service, index, run };
}
const files = {};
for (let i = 0; i < 500; i++) files[`Notes/note-${String(i).padStart(3, '0')}.md`] = `# Synthetic lesson ${i}\n` + 'Obsidian test content 中文. '.repeat(256);
for (let i = 0; i < 40; i++) files[`Attachments/file-${i}.bin`] = Uint8Array.from({ length: 65536 }, (_, k) => (i + k) % 256);
const runDir = join(artifacts, `${label}-${Date.now()}`); const fixture = new GitFixture();
// Real HTTP round trips through the production Git transport, isolated from GitHub.
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  try { const result = await fixture.transport({ url: `https://api.github.com/repos/test-owner/test-repository${req.url}`, method: req.method, headers: {}, throw: false, ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) }); res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.json)); }
  catch { res.destroy(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}`; const remote = { transport: async req => {
  const r = await fetch(api + new URL(req.url).pathname.split('/test-repository')[1] + new URL(req.url).search, { method: req.method, body: req.body, headers: req.headers }); return { status: r.status, json: await r.json() };
} };
const report = { label, at: new Date().toISOString(), environment: { platform: process.platform, node: process.version, files: 540, fixtureBytes: Object.values(files).reduce((s, b) => s + (typeof b === 'string' ? utf8(b).length : b.byteLength), 0), backend: 'Isolated GitHub Git Database HTTP fixture; no live GitHub writes', vault: join(runDir, 'vault') }, scenarios: {} };
try {
  const a = await fixtureDevice(remote, join(runDir, 'vault'), files);
  report.scenarios['first-initialize'] = await a.run(); console.log(label, 'first-initialize', report.scenarios['first-initialize'].elapsedMs.toFixed(1));
  report.scenarios['no-change'] = await a.run(); console.log(label, 'no-change', report.scenarios['no-change'].elapsedMs.toFixed(1));
  await a.vault.edit('Notes/note-000.md', utf8('# Modified one\n' + files['Notes/note-000.md']));
  report.scenarios['modify-1'] = await a.run(); console.log(label, 'modify-1', report.scenarios['modify-1'].elapsedMs.toFixed(1));
  for (let i = 0; i < 10; i++) await a.vault.edit(`Notes/note-${String(i).padStart(3, '0')}.md`, utf8(`# Modified ten ${i}\n` + files[`Notes/note-${String(i).padStart(3, '0')}.md`]));
  report.scenarios['modify-10'] = await a.run(); console.log(label, 'modify-10', report.scenarios['modify-10'].elapsedMs.toFixed(1));
  for (let i = 20; i < 45; i++) { const old = `Notes/note-${String(i).padStart(3, '0')}.md`; const next = old.replace('Notes/', 'Renamed/'); await a.vault.move(old, next); await a.state.recordRename(old, next); }
  report.scenarios['rename-25'] = await a.run(); console.log(label, 'rename-25', report.scenarios['rename-25'].elapsedMs.toFixed(1));
  // Recovery with both a Push and a local PULL write must execute full Verify.
  const b = await fixtureDevice(remote, join(runDir, 'peer'), {}, false); await b.run();
  await b.vault.edit('Notes/note-101.md', utf8('# Remote change for Recovery\n')); await b.run();
  await a.vault.edit('Notes/note-010.md', utf8('# Interrupt publication\n')); const p = await a.service.preview(options, 'fixture-token-only');
  fixture.losePatchResponse = true; await assert.rejects(a.service.execute(p, 'fixture-token-only'));
  const pending = await a.service.transactions.active(); assert(pending); const businessCommits = fixture.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length;
  a.index?.invalidate('recovery'); const start = performance.now(); await a.service.resume(options, 'fixture-token-only');
  report.scenarios.recovery = { elapsedMs: performance.now() - start, ...a.service.performanceSnapshot() };
  assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length, businessCommits);
  assert.equal(await a.service.transactions.active(), null); assert.equal(a.state.current().baseRemoteCommit, fixture.head);
  assert(fixture.calls.filter(c => c.method === 'PATCH').every(c => c.body.force === false));
  for (const [path, sha] of Object.entries(fixture.contents()).filter(([path]) => !path.startsWith('.'))) assert.equal(gitBlobSha(new Uint8Array(await a.vault.readBinary(path))), sha);
  await mkdir(join(runDir, 'test-repository'), { recursive: true }); await writeFile(join(runDir, 'test-repository/evidence.json'), JSON.stringify({ calls: fixture.calls, head: fixture.head, trees: [...fixture.trees], commits: [...fixture.commits] }, null, 2));
  await writeFile(join(artifacts, `${label}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.scenarios, null, 2));
} finally { await new Promise(r => server.close(r)); }
