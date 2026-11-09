import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

// Freeze an instrumented pre-optimization bundle with --index-baseline first.
// Both variants use the existing disk/HTTP fixture and the same safety checks.
const root = resolve(import.meta.dirname, '..'); const artifacts = join(root, 'artifacts/index-performance');
const output = join(artifacts, `comparison-${Date.now()}`); await mkdir(output, { recursive: true });
const rounds = Number(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] ?? 3);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
await readFile(join(artifacts, 'baseline.mjs'));
const results = { baseline: [], optimized: [] };
for (let round = 0; round < rounds; round++) {
  for (const kind of round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
    const run = spawnSync(process.execPath, ['scripts/v12-performance.mjs', kind === 'baseline' ? '--index-use-baseline' : '--index-optimized'],
      { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    await writeFile(join(output, `${round + 1}-${kind}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    assert.equal(run.status, 0, `${kind} round ${round + 1} failed: ${run.stderr ?? run.error}`);
    const report = JSON.parse(await readFile(join(artifacts, `${kind}.json`), 'utf8'));
    results[kind].push(report); await writeFile(join(output, `${round + 1}-${kind}.json`), JSON.stringify(report, null, 2));
    console.log(`Completed ${kind} round ${round + 1}/${rounds}`);
  }
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const scenarios = {};
for (const name of Object.keys(results.baseline[0].scenarios)) {
  for (let i = 0; i < rounds; i++) for (const metric of ['listCalls', 'statCalls', 'localReads', 'apiRequests', 'verification']) {
    assert.equal(results.optimized[i].scenarios[name][metric], results.baseline[i].scenarios[name][metric], `${name}: ${metric} changed`);
  }
  const summarize = reports => {
    const data = reports.map(r => r.scenarios[name]);
    const result = { elapsedMs: median(data.map(d => d.elapsedMs)), operations: {} };
    for (const metric of ['listCalls', 'statCalls', 'localReads', 'apiRequests', 'indexWrites', 'indexWriteBytes']) {
      if (data.every(d => typeof d[metric] === 'number')) result[metric] = median(data.map(d => d[metric]));
    }
    for (const operation of Object.keys(data[0].operations ?? {})) result.operations[operation] = {
      elapsedMs: median(data.map(d => d.operations[operation].elapsedMs)), calls: median(data.map(d => d.operations[operation].calls)),
      failures: median(data.map(d => d.operations[operation].failures)) };
    return result;
  };
  scenarios[name] = { before: summarize(results.baseline), after: summarize(results.optimized) };
}
const summary = { rounds, output, environment: results.optimized[0].environment,
  note: 'Sequential alternating runs on isolated real disk and local HTTP fixture. Values are medians. Operation durations overlap and must not be summed. Save burst includes deliberate waits.',
  accounting: 'Sync measurements cover Preview, execute and final index flush. Writes triggered by an earlier edit can move into the flush window after batching; per-sync index write counts must not be treated as total save costs. Save-burst counts cover the entire edit burst and its flush.',
  safety: 'Directory listing, stat, content-read and API counts plus verification levels match in every paired scenario; each run also checks final bytes, force:false and duplicate-commit recovery.', scenarios };
await writeFile(join(output, 'comparison.json'), JSON.stringify(summary, null, 2));
await writeFile(join(artifacts, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ output, scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, r]) => [name,
  { beforeMs: r.before.elapsedMs, afterMs: r.after.elapsedMs, beforeIndexMs: r.before.operations['Index lookup']?.elapsedMs,
    afterIndexMs: r.after.operations['Index lookup']?.elapsedMs, beforeWrites: r.before.indexWrites, afterWrites: r.after.indexWrites }])) }, null, 2));
