import { LocalChangeIndex, type IndexPolicy } from '../src/vault/LocalChangeIndex';
import { LocalStateStore } from '../src/sync/state/LocalStateStore';
import { SyncService } from '../src/sync/execution/SyncService';
import { GitFixture, WritableVault } from './v1-harness';
import { bytes, target } from './helpers';
export const v12Options = { ...target, includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 100 };
export async function indexedDevice(files: Record<string, string> = {}, remote = new GitFixture(), policy: Partial<IndexPolicy> = {}) {
  const vault = new WritableVault(files);
  const state = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) }); await state.load();
  const storage = { read: () => vault.readInternal('index'), write: (s: string) => vault.writeInternal('index', s) };
  const index = new LocalChangeIndex(storage, policy); await index.load();
  const service = new SyncService(vault, remote.transport, '.obsidian', state, undefined, index);
  const edit = (path: string, content: string) => { vault.files.set(path, bytes(content)); index.record('modify', path); };
  const remove = async (path: string) => { vault.files.delete(path); index.record('delete', path); await state.recordDelete(path); };
  const move = async (old: string, path: string) => { vault.files.set(path, vault.files.get(old)!); vault.files.delete(old); index.record('rename', path, old); await state.recordRename(old, path); };
  const apply = vault.apply.bind(vault); vault.apply = async (...args) => { await apply(...args); index.record(args[1] ? 'modify' : 'delete', args[0]); };
  const run = async (opts = v12Options) => { const p = await service.preview(opts, 'fixture'); await service.execute(p, 'fixture'); };
  return { vault, state, index, storage, service, remote, edit, remove, move, run };
}
