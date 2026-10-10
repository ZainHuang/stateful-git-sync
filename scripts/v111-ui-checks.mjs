import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyV111({ page, remote, report, runDir, preview, sync, close, state, surface, getUI, inject, setDropPatch, WritableVault, LocalStateStore, SyncService, options }) {
  const capture = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const dashboard = async () => {
    await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
    await surface('.lms-dashboard:visible .lms-recovery-panel');
    await getUI().locator('.lms-recovery-panel').getByText(/^(Healthy|Pending Recovery)$/).waitFor();
  };
  const active = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  const original = await state();
  await dashboard();
  assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Recovery Status\s+Healthy/);
  report.checks.push('Empty dashboard shows Recovery Status Healthy from local transaction storage');
  // Fail before publication using the existing production HTTP transport boundary.
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; const transport = plugin.sync.transport;
    plugin.sync.transport = req => window.__failRecoveryBlobs && req.method === 'POST' && req.url.endsWith('/blobs')
      ? Promise.resolve({ status: 403, json: {} }) : transport(req);
    window.__failRecoveryBlobs = true;
  });
  await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  const pending = await active(); assert.equal(pending.phase, 'prepared');
  await close(); await dashboard();
  const panel = await getUI().locator('.lms-recovery-panel').innerText();
  for (const label of ['Pending Recovery', 'Transaction ID', pending.id, 'Phase', 'Created Time', 'Repository', 'test-owner/test-repository']) assert(panel.includes(label));
  const reads = remote.calls.length; await dashboard(); assert.equal(remote.calls.length, reads);
  await capture('v111-01-pending-dashboard');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openPreview());
  await surface('.lms-modal');
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor();
  assert.equal(await getUI().getByRole('button', { name: 'Retry Preview', exact: true }).count(), 0);
  for (const name of ['Resume Transaction', 'Abort Transaction']) assert.equal(await getUI().getByRole('button', { name, exact: true }).count(), 1);
  await capture('v111-02-blocked-preview');
  report.checks.push('Pending dashboard shows transaction details without HTTP; blocked Preview offers Review/Resume/Abort and no Retry Preview');
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).click();
  await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v111-03-recovery-mobile');
  const head = remote.head; const count = remote.calls.length;
  // Even damaged state must not be repaired by Abort.
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].stateError = new Error('injected state diagnostic'); });
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).click();
  await getUI().getByText('Transaction aborted. Recovery backups retained. Run Preview again.', { exact: true }).waitFor();
  assert.equal(await active(), null); assert.equal(remote.head, head);
  assert(remote.calls.slice(count).every(c => c.method === 'GET')); assert.deepEqual(await state(), original);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Original\nWindows note');
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('.local-mirror-sync/transactions/active.json')), false);
  assert.equal(await page.evaluate(id => app.vault.adapter.exists(`.local-mirror-sync/transactions/${id}/journal.json`), pending.id), true);
  await page.evaluate(() => { const p = app.plugins.plugins['local-mirror-sync']; p.stateError = undefined; window.__failRecoveryBlobs = false; p.recoveryModal.close(); });
  await dashboard(); assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Healthy/);
  report.checks.push('390px Recovery Abort deletes only active pointer, retains journal and backups, makes GET-only calls, preserves user notes and BASE even with a state error');
  await preview(); await sync(); await close();
  const beforeRecovery = await state();
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Published recovery'); });
  setDropPatch(true); await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor(); setDropPatch(false);
  const publishedHead = remote.head; await close();
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).click();
  await getUI().getByText(/RECOVERY_ENV_CHANGED/).waitFor();
  assert.equal(await getUI().getByRole('button', { name: 'Preview again', exact: true }).count(), 0,
    'Blocked Recovery must not offer a Preview that immediately routes back to Recovery');
  assert(!(await getUI().locator('.lms-recovery-status').innerText()).includes('run a fresh Preview'));
  assert(await active()); assert.equal(remote.head, publishedHead); assert.deepEqual(await state(), beforeRecovery);
  const readsBeforeMismatch = remote.calls.length;
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].settings.branch = 'other'; });
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/repository\/branch differs/).waitFor();
  assert.equal(remote.calls.length, readsBeforeMismatch);
  assert.equal(await getUI().getByRole('button', { name: 'Preview again', exact: true }).count(), 0);
  assert(await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).isEnabled());
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].settings.branch = 'main'; });
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; const transport = plugin.sync.transport;
    window.__failRecoveryHead = true;
    plugin.sync.transport = req => window.__failRecoveryHead && req.method === 'GET' && req.url.endsWith('/ref/heads/main')
      ? Promise.resolve({ status: 503, json: {} }) : transport(req);
  });
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/HTTP_503/).waitFor();
  assert((await getUI().locator('.lms-recovery-status').innerText()).includes('retry Resume Transaction'));
  assert.equal(await getUI().getByRole('button', { name: 'Preview again', exact: true }).count(), 0);
  assert(await active()); assert.deepEqual(await state(), beforeRecovery);
  await page.evaluate(() => { window.__failRecoveryHead = false; });
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v111-04-published-abort-blocked');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await surface('.lms-summary');
  assert.equal(await active(), null); assert.equal(remote.head, publishedHead); assert((await state()).baseManifest.generation > beforeRecovery.baseManifest.generation);
  await capture('v111-05-resumed');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());
  await dashboard(); assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Healthy/);
  report.checks.push('Lost publish response survives reload; blocked Abort, target mismatch and HTTP_503 offer no circular Preview, preserve BASE and enable Resume after correction; Resume verifies the original published commit and clears recovery');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByText('No pending sync. You can run Preview again.', { exact: true }).waitFor();
  report.checks.push('Empty Recovery dialog provides a fresh Preview action after completion');

  // The runner owns this generated Vault and synthetic GitHub fixture. Reuse
  // its original uninitialized state to exercise Use Local through real buttons.
  await page.evaluate(async original => {
    const plugin = app.plugins.plugins['local-mirror-sync']; plugin.recoveryModal.close();
    await plugin.metadataPending; await plugin.syncState.save(original);
    const transport = plugin.sync.transport; window.__v111BeforeAdoptionTransport = transport; let published = false;
    plugin.sync.transport = async req => {
      // Immutable Commit reads can now be reused after pre-publication proof.
      // Fail a mandatory fresh HEAD check once the durable phase is published.
      if (published && req.method === 'GET' && req.url.endsWith('/ref/heads/main')
        && (await plugin.sync.transactions.active())?.phase === 'published') {
        published = false; return { status: 503, json: {} };
      }
      const response = await transport(req);
      if (req.method === 'PATCH' && response.status === 200) published = true;
      return response;
    };
  }, original);
  remote.external({ 'legacy.md': '# Legacy remote' });
  await preview(); await getUI().getByRole('button', { name: 'Use Local', exact: true }).click();
  await getUI().getByRole('button', { name: 'Adopt & Verify', exact: true }).click();
  await getUI().getByRole('textbox', { name: 'Adoption confirmation', exact: true }).fill('USE LOCAL');
  await getUI().getByRole('button', { name: 'Confirm & Adopt', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor();
  const adoption = await active(); assert.equal(adoption.phase, 'published'); assert.equal(adoption.adoptionChoice, 'local');
  assert.deepEqual(adoption.before, adoption.after);
  const bVault = new WritableVault();
  for (const [path, sha] of Object.entries(adoption.after)) bVault.files.set(path, remote.blobs.get(sha).slice());
  const bState = new LocalStateStore({ read: () => bVault.readInternal('state'), write: s => bVault.writeInternal('state', s) });
  await bState.load(); const bSync = new SyncService(bVault, req => remote.transport(req), '.obsidian', bState);
  const bRun = async () => bSync.execute(await bSync.preview(options, 'fixture'), 'fixture');
  await bRun(); bVault.files.set('note.md', new TextEncoder().encode('# Other device edit'));
  bVault.files.set('other-device.md', new TextEncoder().encode('# Other device addition')); await bRun();
  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Later local edit');
    await app.vault.create('local-added.md', '# Later local addition'); await plugin.metadataPending;
  });
  const currentHead = remote.head; const currentManifest = remote.text('.local-mirror-sync/manifest.json');
  await close(); await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery());
  await surface('.lms-recovery-dialog'); await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v111-06-adoption-advanced-main');
  const recoveryReads = remote.calls.length;
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click(); await surface('.lms-summary');
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert.equal(await active(), null); assert.equal((await state()).baseRemoteCommit, adoption.commit);
  assert.deepEqual((await state()).baseManifest, adoption.manifest);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Later local edit');
  assert.equal(await page.evaluate(() => app.vault.adapter.read('local-added.md')), '# Later local addition');
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('other-device.md')), false);
  assert.equal(remote.head, currentHead); assert.equal(remote.text('.local-mirror-sync/manifest.json'), currentManifest);
  assert(remote.calls.slice(recoveryReads).every(c => c.method === 'GET'));
  const plan = await getUI().locator('.lms-modal').innerText();
  for (const category of ['CONFLICT_CONTENT', 'PUSH_ADD', 'PULL_ADD']) assert(plan.includes(category), plan);
  assert(await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).isDisabled());
  assert(await getUI().locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v111-07-adoption-resumed-preview');
  report.checks.push('390px published Use Local Adoption with advanced main resumes using GET-only proof of the original commit/backup; preserves both devices edits and opens normal conflict/Push/Pull Preview without applying files');

  // A published transaction with PULL writes must preserve an unexpected edit,
  // then let the user explicitly replan instead of endlessly retrying Resume.
  await close();
  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['local-mirror-sync']; plugin.sync.transport = window.__v111BeforeAdoptionTransport; await plugin.metadataPending;
    const p = await plugin.sync.preview(plugin.settings, plugin.tokens.read(plugin.settings));
    const reviewed = plugin.sync.resolveAll(p, 'remote');
    const apply = plugin.sync.vault.apply; let interrupted = false;
    plugin.sync.vault.apply = async (...args) => {
      if (!interrupted && args[0] === 'note.md') { interrupted = true; throw new Error('Fixture interrupted before local Pull'); }
      return apply(...args);
    };
    try { await plugin.sync.execute(reviewed, plugin.tokens.read(plugin.settings)); }
    catch (error) { if (!String(error).includes('Fixture interrupted')) throw error; }
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Possible accidental mobile edit'); await plugin.metadataPending;
  });
  const localWriteTransaction = await active(); assert.equal(localWriteTransaction.phase, 'published');
  assert.notDeepEqual(localWriteTransaction.before, localWriteTransaction.after);
  const unchangedBase = await state(); const replannedHead = remote.head; const readsBeforeReplan = remote.calls.length;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/LOCAL_CHANGED/).waitFor();
  await capture('v111-08-local-write-blocked');
  assert((await getUI().locator('.lms-recovery-status').innerText()).includes('note.md'), 'Recovery must name the affected local path');
  const fresh = getUI().getByRole('button', { name: 'Start fresh Preview from current HEAD', exact: true });
  await fresh.waitFor({ timeout: 5000 });
  assert(await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).isEnabled());
  assert(await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).isDisabled());
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await fresh.scrollIntoViewIfNeeded();
  await capture('v111-09-local-changes-mobile');
  await fresh.click(); await surface('.lms-summary');
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert.equal(await active(), null); assert.deepEqual(await state(), unchangedBase); assert.equal(remote.head, replannedHead);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Possible accidental mobile edit');
  assert(remote.calls.slice(readsBeforeReplan).every(c => c.method === 'GET'));
  assert((await getUI().locator('.lms-modal').innerText()).includes('CONFLICT_CONTENT'));
  assert(await getUI().locator('.lms-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert(await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).isDisabled());
  assert.equal(await page.evaluate(id => app.vault.adapter.exists(`.local-mirror-sync/transactions/${id}/journal.json`), localWriteTransaction.id), true);
  await capture('v111-10-local-changes-replanned');
  report.checks.push('Published PULL with an unexpected local edit names note.md, keeps Resume enabled and Abort blocked at 390px, and explicitly starts a verified fresh Preview with BASE/current bytes/GitHub unchanged and an unresolved conflict');
}
