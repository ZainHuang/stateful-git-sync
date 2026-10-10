import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Raw bytes, including BOM/CRLF, are hashed exactly as a Git blob. */
export interface HashMeasurement { onHash(bytes: number, elapsedMs: number, metadata?: boolean): void }
export function gitBlobSha(data: ArrayBuffer | Uint8Array, measurement?: HashMeasurement, metadata = false): string {
  const started = measurement ? performance.now() : 0;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const result = bytesToHex(sha1.create().update(header).update(bytes).digest());
  measurement?.onHash(bytes.byteLength, performance.now() - started, metadata);
  return result;
}
