import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function verifyV12({ page, remote, report, runDir, preview, sync, close, surface, state, getUI, inject, WritableVault, LocalStateStore, SyncService, options }) {
  const shot = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const metrics = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.performanceSnapshot());
  const run = async () => {
    const before = performance.now(); await preview(); const scan = await metrics(); await sync(); const execution = await metrics(); await close();
    return { elapsedMs: performance.now() - before, localReads: scan.localReads + execution.localReads, hashBytes: scan.hashBytes + execution.hashBytes, apiRequests: scan.apiRequests + execution.apiRequests, verification: execution.verification, scan, execution };
  };
  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    // Disposable fixture only; production large-deletion confirmations remain
    // covered by the existing V1 / keyboard / adoption integration suites.
    await plugin.saveSettings({ ...plugin.settings, deleteSafetyThreshold: 100 });
    await app.vault.createFolder('Performance'); await app.vault.createFolder('Attachments');
    for (let i = 0; i < 500; i++) await app.vault.create(`Performance/note-${String(i).padStart(3, '0')}.md`, `# Fixture ${i}\n` + 'Synthetic Obsidian 内容. '.repeat(256));
    for (let i = 0; i < 38; i++) await app.vault.createBinary(`Attachments/data-${i}.bin`, Uint8Array.from({ length: 4096 }, (_, j) => (i + j) % 256).buffer);
    const p = app.plugins.plugins['local-mirror-sync']; await p.metadataPending; await p.changeIndex.flush();
    if (app.vault.getFiles().length !== 540) throw new Error('Isolated fixture must have exactly 540 user files');
  });
  const benchmark = { at: new Date().toISOString(), files: 540, environment: 'Real Windows Obsidian, synthetic Vault, HTTP GitHub fixture', scenarios: {} };
  benchmark.scenarios.initialize = await run(); assert.equal(benchmark.scenarios.initialize.verification, 'Full Integrity Verified');
  benchmark.scenarios.noChange = await run(); assert(benchmark.scenarios.noChange.localReads < 30); assert.equal(benchmark.scenarios.noChange.verification, 'Incremental Verified');
  report.checks.push('Real Obsidian 540-file initialization uses full verification; no-change reads only audit samples and immutable metadata is reused');
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('Performance/note-200.md'), '# Single actual Vault event'); });
  benchmark.scenarios.modify1 = await run(); assert.equal(remote.text('Performance/note-200.md'), '# Single actual Vault event'); assert(benchmark.scenarios.modify1.localReads < 40);
  await page.evaluate(async () => { for (let i = 210; i < 220; i++) await app.vault.modify(app.vault.getAbstractFileByPath(`Performance/note-${i}.md`), `# Ten notes ${i}`); });
  benchmark.scenarios.modify10 = await run(); assert(benchmark.scenarios.modify10.localReads < 80);
  for (let i = 210; i < 220; i++) assert.equal(remote.text(`Performance/note-${i}.md`), `# Ten notes ${i}`);
  const beforeRename = await state();
  await page.evaluate(async () => { await app.vault.createFolder('Renamed'); for (let i = 230; i < 255; i++) await app.vault.rename(app.vault.getAbstractFileByPath(`Performance/note-${i}.md`), `Renamed/note-${i}.md`); });
  benchmark.scenarios.rename25 = await run(); const afterRename = await state();
  for (let i = 230; i < 255; i++) {
    assert.equal(remote.contents()[`Performance/note-${i}.md`], undefined);
    const original = Object.values(beforeRename.baseManifest.files).find(f => f.path === `Performance/note-${i}.md`);
    assert.equal(afterRename.baseManifest.files[original.fileId].path, `Renamed/note-${i}.md`);
  }
  report.checks.push('Actual Obsidian modify events (1/10 notes), 25 rename events and binary attachments round-trip with stable IDs and bounded reads');
  for (const [name, width, height] of [['ios', 390, 844], ['android', 412, 915]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.body.classList.add('emulate-mobile'));
    const requests = remote.calls.length; await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel()); await surface('.lms-activity-panel');
    const ui = getUI();
    await ui.setViewportSize({ width, height }); await ui.evaluate(() => document.body.classList.add('emulate-mobile'));
    assert.equal(await ui.evaluate(() => innerWidth), width); assert.equal(await ui.evaluate(() => innerHeight), height);
    await ui.locator('.lms-activity-current').getByText('Verified', { exact: true }).waitFor();
    assert.equal(await ui.locator('.lms-technical-details').getAttribute('open'), null);
    assert.equal(await ui.locator('.lms-business-stages').isVisible(), false);
    await ui.locator('.lms-technical-details summary').click(); assert.equal(await ui.locator('.lms-performance-table tbody tr').count(), 5);
    assert(await ui.locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.equal(remote.calls.length, requests); await shot(`v12-${name}-details`);
    await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].activityPanel.close());
  }
  report.checks.push('iOS 390px / Android 412px emulation: static Verified, expandable exact technical stages and measurements, contained overflow, no requests on panel open');
  await page.setViewportSize({ width: 1200, height: 900 }); await page.evaluate(() => document.body.classList.remove('emulate-mobile'));
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; const record = p.changeIndex.record;
    p.changeIndex.record = () => {};
    await app.vault.modify(app.vault.getAbstractFileByPath('Performance/note-300.md'), '# Missed event before mobile resume');
    p.changeIndex.record = record; document.dispatchEvent(new Event('resume'));
  });
  benchmark.scenarios.mobileResume = await run(); assert.equal(benchmark.scenarios.mobileResume.verification, 'Full Integrity Verified'); assert.equal(remote.text('Performance/note-300.md'), '# Missed event before mobile resume');
  await page.evaluate(async () => { const p = app.plugins.plugins['local-mirror-sync']; await p.changeIndex.flush(); await app.vault.adapter.write(`${app.vault.configDir}/plugins/local-mirror-sync/local-change-index.json`, '{damaged'); });
  benchmark.scenarios.indexDamage = await run(); assert.equal(benchmark.scenarios.indexDamage.verification, 'Full Integrity Verified');
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  benchmark.scenarios.restart = await run(); assert.equal(benchmark.scenarios.restart.verification, 'Full Integrity Verified');
  report.checks.push('Native resume signal, suppressed file events, damaged persisted index and plugin restart all force full reconciliation without lost bytes');
  const readonlyState = await state(); const readonlyCalls = remote.calls.length;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openPreview(true)); await surface('.lms-summary');
  assert.equal(await getUI().locator('.lms-execute').count(), 0); assert.equal((await metrics()).verification, 'Full Integrity Verified');
  assert.deepEqual(await state(), readonlyState); assert(remote.calls.slice(readonlyCalls).every(c => c.method === 'GET')); await close();
  report.checks.push('Standalone Verify remains read-only and performs a real full content audit with exact Full Integrity Verified labeling');
  // A mixed Push/Pull transaction exercises full local Recovery, not the existing
  // Push-only published-snapshot special case.
  const vault = new WritableVault(); const peerState = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) }); await peerState.load();
  const peer = new SyncService(vault, remote.transport, '.obsidian', peerState); const peerRun = async () => peer.execute(await peer.preview(options, 'fixture'), 'fixture'); await peerRun();
  vault.files.set('Performance/note-320.md', new TextEncoder().encode('# Recovery remote change')); await peerRun();
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('Performance/note-321.md'), '# Recovery local Push'); });
  const base = (await state()).baseRemoteCommit;
  await preview();
  await page.evaluate(() => { const v = app.plugins.plugins['local-mirror-sync'].sync.vault; window.__v12Apply = v.apply; v.apply = () => { throw new Error('Synthetic disk interruption'); }; });
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click(); await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  assert.equal((await state()).baseRemoteCommit, base); await close();
  const commits = remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length;
  const recoveryStart = performance.now(); await page.evaluate(async () => { const p = app.plugins.plugins['local-mirror-sync']; p.sync.vault.apply = window.__v12Apply; await p.sync.resume(p.syncOptions(), p.tokens.read(p.settings)); p.queueIdentityUpdates(); await p.metadataPending; });
  benchmark.scenarios.recovery = { ...await metrics(), elapsedMs: performance.now() - recoveryStart };
  assert.equal(benchmark.scenarios.recovery.verification, 'Full Integrity Verified'); assert.equal(remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length, commits);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('Performance/note-320.md')), '# Recovery remote change');
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active()), null);
  report.checks.push('Mixed Push/Pull interruption retains BASE and Recovery; Resume fully verifies 540 files, applies incoming content and creates zero duplicate business commits');
  await writeFile(join(runDir, 'v12-obisidian-performance.json'), JSON.stringify(benchmark, null, 2)); report.performance = benchmark;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel()); await surface('.lms-activity-panel'); await shot('v12-full-recovery-verified');
}
