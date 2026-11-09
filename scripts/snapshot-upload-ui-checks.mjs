import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifySnapshotUpload({ page, remote, report, runDir, preview, sync, close, surface, state, getUI, WritableVault, LocalStateStore, SyncService, options }) {
  await page.evaluate(async () => { await app.vault.create('other.md', 'other'); await app.vault.create('remove.md', 'remove'); });
  await preview(); await sync(); await close();
  const original = await state();
  const id = Object.values(original.baseManifest.files).find(f => f.path === 'other.md').fileId;
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    await p.saveSettings({ ...p.settings, autoSync: true, autoSyncDebounceSeconds: 30 });
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), 'frozen upload');
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('note.md'));
  });
  await page.waitForFunction(() => app.workspace.activeEditor?.editor?.getValue() === 'frozen upload');
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync'];
    const transport = p.sync.transport;
    let first = true;
    p.sync.transport = async r => {
      if (first && r.method === 'POST' && r.url.endsWith('/blobs')) {
        first = false; window.__snapshotHeld = true;
        await new Promise(resolve => { window.__snapshotRelease = resolve; });
      }
      return transport(r);
    };
    window.__snapshotRun = p.auto.run();
  });
  await page.waitForFunction(() => window.__snapshotHeld);
  await page.locator('.workspace-leaf.mod-active .cm-content[contenteditable="true"]').fill('edited while upload is held');
  await page.evaluate(async () => {
    await app.vault.rename(app.vault.getAbstractFileByPath('other.md'), 'renamed.md');
    await app.vault.modify(app.vault.getAbstractFileByPath('renamed.md'), 'renamed while uploading');
    await app.vault.delete(app.vault.getAbstractFileByPath('remove.md'));
    await app.vault.create('later.md', 'created while uploading');
    await app.vault.modifyBinary(app.vault.getAbstractFileByPath('binary.png'), new Uint8Array([7, 8, 9]).buffer);
  });
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate(() => app.vault.adapter.read('note.md')) === 'edited while upload is held') break;
    await page.waitForTimeout(100);
  }
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), 'edited while upload is held');
  await page.evaluate(async () => { window.__snapshotRelease(); await window.__snapshotRun; });
  assert.equal(remote.text('note.md'), 'frozen upload'); assert.equal(remote.text('other.md'), 'other');
  assert.equal(remote.contents()['later.md'], undefined); assert(remote.contents()['remove.md']);
  const pending = await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    return { activity: p.product.activitySnapshot(), cache: p.product.snapshot(), active: await p.sync.transactions.active(), local: await app.vault.adapter.read('note.md'), index: p.changeIndex.snapshot(), indicator: p.activityStatus() };
  });
  report.snapshotPending = pending;
  assert.equal(pending.active, null); assert.equal(pending.local, 'edited while upload is held');
  assert.equal(pending.activity.verified, true); assert.equal(pending.activity.pendingChanges, true); assert.equal(pending.activity.verification, 'Published Snapshot Verified');
  assert.equal(pending.cache.status, 'Sync Required'); assert.equal(pending.cache.auto.result, 'Verified'); assert(pending.cache.auto.scheduledAt);
  assert.equal(pending.indicator.label, 'Snapshot synced · New changes queued');
  report.checks.push('Real editor saves plus binary/add/delete/rename during a held Auto Sync preserve local bytes, publish only the frozen snapshot, retain pending changes and leave no Recovery');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel()); await surface('.lms-activity-panel');
  for (const [name, width, height] of [['desktop', 1200, 900], ['mobile', 390, 844]]) {
    const ui = getUI(); await ui.setViewportSize({ width, height });
    await ui.locator('.lms-activity-current').getByText('本轮已同步，新的修改等待下一轮', { exact: true }).waitFor();
    assert(await ui.locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await ui.screenshot({ path: join(runDir, `snapshot-${name}-queued.png`) }); report.screenshots.push(`snapshot-${name}-queued.png`);
    await ui.locator('.lms-technical-details summary').click();
    assert.equal(await ui.locator('.lms-operation-performance tbody tr').count(), 10);
    await ui.getByText('操作明细（本轮预览 + 执行）', { exact: true }).waitFor();
    assert(await ui.locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await ui.locator('.lms-operation-performance').scrollIntoViewIfNeeded();
    await ui.screenshot({ path: join(runDir, `snapshot-${name}-operations.png`) }); report.screenshots.push(`snapshot-${name}-operations.png`);
    await ui.locator('.lms-technical-details summary').click();
  }
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].activityPanel.close());
  // Use the already-scheduled timer to prove the next round starts autonomously.
  let completed = false;
  for (let i = 0; i < 45; i++) {
    completed = await page.evaluate(() => {
      const p = app.plugins.plugins['local-mirror-sync'];
      return !p.sync.running && !p.auto.running && !p.product.activitySnapshot().pendingChanges && p.product.snapshot().auto.result === 'Verified'
        && Object.values(p.syncState.current().baseManifest.files).some(f => !f.deleted && f.path === 'later.md');
    });
    if (completed) break;
    await page.waitForTimeout(1000);
  }
  assert(completed, 'The already-scheduled next round must finish');
  assert.equal(remote.text('note.md'), 'edited while upload is held'); assert.equal(remote.text('renamed.md'), 'renamed while uploading');
  assert.equal(remote.text('later.md'), 'created while uploading'); assert.equal(remote.contents()['other.md'], undefined); assert.equal(remote.contents()['remove.md'], undefined);
  assert.equal((await state()).baseManifest.files[id].path, 'renamed.md');
  assert.deepEqual([...remote.blobs.get(remote.contents()['binary.png'])], [7, 8, 9]);
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; const preview = p.sync.preview.bind(p.sync); let once = true;
    p.sync.preview = async (...args) => {
      const result = await preview(...args);
      if (once) {
        once = false; await app.vault.modify(app.vault.getAbstractFileByPath('later.md'), 'edited during Preview');
        const ticket = p.changeIndex.ticket(result.scopeKey); p.changeIndex.record('modify', 'later.md');
        p.changeIndex.assertCurrent(ticket);
      }
      return result;
    };
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), 'queued after Preview collision');
    await p.auto.run(); p.sync.preview = preview;
  });
  const retry = await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    return { cache: p.product.snapshot(), activity: p.product.activitySnapshot(), enabled: p.settings.autoSync, active: await p.sync.transactions.active(), indicator: p.activityStatus() };
  });
  assert.equal(retry.enabled, true); assert.equal(retry.cache.auto.result, 'Waiting to retry'); assert(retry.cache.auto.scheduledAt);
  assert.equal(retry.activity.error, undefined); assert.equal(retry.activity.retrying, true); assert.equal(retry.active, null);
  assert(retry.indicator.label.includes('等待自动重试')); report.automaticRetry = retry;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel()); await surface('.lms-activity-panel');
  for (const [name, width, height] of [['desktop', 1200, 900], ['mobile', 390, 844]]) {
    const ui = getUI(); await ui.setViewportSize({ width, height });
    await ui.locator('.lms-activity-current').getByText('等待自动重试', { exact: true }).waitFor();
    assert((await ui.locator('.lms-activity-health').innerText()).includes('等待自动重试'));
    assert.equal(await ui.locator('.lms-activity-error').getAttribute('role'), 'status');
    assert(await ui.locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await ui.screenshot({ path: join(runDir, `automatic-retry-${name}.png`) }); report.screenshots.push(`automatic-retry-${name}.png`);
  }
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; p.activityPanel.close();
    await p.saveSettings({ ...p.settings, autoSyncDebounceSeconds: 2 });
  });
  await page.waitForFunction(() => {
    const p = app.plugins.plugins['local-mirror-sync']; return !p.sync.running && !p.auto.running && p.product.snapshot().auto.result === 'Verified';
  }, null, { timeout: 15000 });
  assert.equal(remote.text('note.md'), 'queued after Preview collision'); assert.equal(remote.text('later.md'), 'edited during Preview');
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; const transport = p.sync.transport; let once = true;
    p.sync.transport = async request => { if (once && request.method === 'GET') { once = false; throw new Error('Temporary fixture disconnection'); } return transport(request); };
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), 'queued while temporarily offline');
    await p.auto.run(); p.sync.transport = transport;
    if (p.product.snapshot().auto.result !== 'Waiting to retry' || !p.settings.autoSync) throw new Error('A network failure must leave automatic retry enabled');
  });
  await page.waitForFunction(() => {
    const p = app.plugins.plugins['local-mirror-sync']; return !p.sync.running && !p.auto.running && p.product.snapshot().auto.result === 'Verified';
  }, null, { timeout: 15000 });
  assert.equal(remote.text('note.md'), 'queued while temporarily offline');
  report.checks.push('Real Preview edits and a temporary network failure retain Auto Sync, show a retry countdown on desktop and mobile, then sync automatically without another edit or manual Preview');
  await page.evaluate(async () => { const p = app.plugins.plugins['local-mirror-sync']; await p.saveSettings({ ...p.settings, autoSync: false }); });
  report.checks.push('The scheduled next round uploads every later edit automatically, preserves rename identity and applies the recorded deletion without duplicate publication');
  report.checks.push('Desktop and 390px mobile technical details expose all ten measured operations, include the originating Preview, and fit without horizontal overflow');
  // The same production adapter must still protect a locally edited download.
  const vault = new WritableVault(); const peerState = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) }); await peerState.load();
  const peer = new SyncService(vault, remote.transport, '.obsidian', peerState);
  const peerRun = async () => peer.execute(await peer.preview(options, 'fixture'), 'fixture'); await peerRun();
  vault.files.set('renamed.md', new TextEncoder().encode('incoming remote')); await peerRun();
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), 'local push'); });
  const before = (await state()).baseRemoteCommit; await preview();
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; const transport = p.sync.transport;
    p.sync.transport = async r => {
      if (r.method === 'PATCH') await app.vault.modify(app.vault.getAbstractFileByPath('renamed.md'), 'protected local edit');
      return transport(r);
    };
  });
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => app.vault.adapter.read('renamed.md')), 'protected local edit'); assert.equal((await state()).baseRemoteCommit, before);
  assert(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active()));
  report.checks.push('A mixed Push/Pull with a concurrent local edit still blocks overwrite, keeps the old BASE and retains its recovery journal');
  await close();
}
