import { describe, expect, it } from 'vitest';
import { LocalChangeIndex } from '../src/vault/LocalChangeIndex';
import { VaultScanner } from '../src/vault/VaultScanner';
import { IgnoreService } from '../src/vault/IgnoreService';
import { MemoryVault, bytes, referenceSha } from './helpers';

describe('V1.2 incremental scanner independent byte oracle', () => {
  it.each(Array.from({ length: 30 }, (_, seed) => seed))('seed %i: create/modify/delete/rename/binary matches full physical bytes', async seed => {
    let random = seed + 1; const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const vault = new MemoryVault(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`notes/${i}.md`, `note ${i}`])));
    let raw: string | null = null;
    const index = new LocalChangeIndex({ read: async () => raw, write: async s => { raw = s; } }); await index.load();
    const ignore = new IgnoreService({ configDir: '.obsidian', includeObsidian: false, gitignore: '', patterns: '' });
    const scanner = new VaultScanner(vault);
    for (let step = 0; step < 40; step++) {
      const paths = [...vault.files.keys()]; const path = paths[next() % paths.length]!;
      const action = next() % 4;
      if (action === 0) { const added = `new/${seed}-${step}.bin`; vault.files.set(added, Uint8Array.from([step, 0, 255, seed])); index.record('create', added); }
      else if (action === 1) { vault.files.set(path, bytes(`modified ${seed} ${step}`)); index.record('modify', path); }
      else if (action === 2) { vault.files.delete(path); index.record('delete', path); }
      else { const moved = `moved/${seed}-${step}.md`; vault.files.set(moved, vault.files.get(path)!); vault.files.delete(path); index.record('rename', moved, path); }
      const scan = await scanner.scan(ignore, undefined, undefined, [], undefined, { index, scopeKey: 'property', audit: true });
      expect(Object.fromEntries(scan.files.map(f => [f.path, f.sha]))).toEqual(Object.fromEntries([...vault.files].map(([p, data]) => [p, referenceSha(data)])));
      index.completed();
    }
  });
});
