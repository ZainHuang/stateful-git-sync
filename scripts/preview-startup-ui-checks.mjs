import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyPreviewStartup({ page, remote, report, runDir, preview, close, surface, getUI, state }) {
  const before = await state(); const head = remote.head; const requests = remote.calls.length;
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    window.__previewStartupTransport = plugin.sync.transport;
    plugin.metadataPending = new Promise(resolve => { window.__previewStartupRelease = resolve; });
    plugin.openPreview();
  });
  await surface('.lms-preview-modal');
  let ui = getUI(); await ui.setViewportSize({ width: 390, height: 844 });
  await ui.evaluate(() => document.body.classList.add('emulate-mobile'));
  assert.deepEqual(await ui.locator('.lms-business-stages li').allTextContents(), ['检查差异', '同步文件', '安全校验']);
  await ui.locator('.lms-technical-details summary').click();
  await ui.getByText('Waiting for local file identity updates', { exact: true }).waitFor();
  const bounds = await ui.locator('.lms-preview-modal').boundingBox();
  const cancel = ui.getByRole('button', { name: 'Cancel', exact: true }); const cancelBounds = await cancel.boundingBox();
  assert(bounds && cancelBounds); assert(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert(cancelBounds.y >= 0 && cancelBounds.y + cancelBounds.height <= 844);
  assert(await ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await ui.screenshot({ path: join(runDir, 'mobile-preview-wait.png') }); report.screenshots.push('mobile-preview-wait.png');
  await cancel.click(); await ui.locator('.lms-preview-modal').waitFor({ state: 'hidden' });
  assert.equal(remote.calls.length, requests); assert.deepEqual(await state(), before);
  await page.evaluate(async () => { window.__previewStartupRelease(); await app.plugins.plugins['local-mirror-sync'].metadataPending; });
  report.checks.push('Mobile loading names the local queue; Cancel is visible, ends the wait and starts no GitHub request or BASE change');

  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; plugin.metadataPending = new Promise(() => {}); plugin.openPreview();
  });
  await surface('.lms-preview-modal'); ui = getUI(); await ui.setViewportSize({ width: 390, height: 844 });
  await ui.locator('.lms-error[role="alert"]').waitFor({ timeout: 36_000 });
  assert.match(await ui.locator('.lms-preview-modal').innerText(), /LOCAL_STATE · READ_TIMEOUT/);
  assert.equal(remote.calls.length, requests); assert.deepEqual(await state(), before);
  await ui.screenshot({ path: join(runDir, 'mobile-preview-local-timeout.png') }); report.screenshots.push('mobile-preview-local-timeout.png');
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].metadataPending = Promise.resolve(); });
  await ui.getByRole('button', { name: 'Retry Preview', exact: true }).click();
  await surface('.lms-summary'); await close();
  report.checks.push('Stalled local queue reports READ_TIMEOUT after 30 seconds; explicit retry reaches the normal plan without changing BASE');

  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    plugin.sync.transport = () => new Promise(resolve => { window.__previewStartupNetworkRelease = resolve; });
    plugin.openPreview();
  });
  await surface('.lms-preview-modal'); ui = getUI(); await ui.setViewportSize({ width: 390, height: 844 });
  await ui.locator('.lms-error[role="alert"]').waitFor({ timeout: 36_000 });
  assert.match(await ui.locator('.lms-preview-modal').innerText(), /REMOTE_REF · NETWORK_TIMEOUT/);
  assert.deepEqual(await state(), before); assert.equal(remote.head, head);
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    window.__previewStartupNetworkRelease({ status: 200, json: { stale: true } });
    plugin.sync.transport = window.__previewStartupTransport;
  });
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.running), false);
  await ui.getByRole('button', { name: 'Retry Preview', exact: true }).click(); await surface('.lms-summary');
  assert.deepEqual(await state(), before); assert.equal(remote.head, head); await close();
  report.checks.push('Stalled GitHub GET reports NETWORK_TIMEOUT; late response cannot produce a plan; retry releases and reuses the Preview lock safely');

  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['local-mirror-sync']; const revision = plugin.product.revision;
    await app.vault.create('after-startup.md', 'Real create after layout ready');
    await plugin.metadataPending; await plugin.productPending;
    if (plugin.product.revision <= revision) throw new Error('Real file creation was not observed after startup');
  });
  await preview();
  assert.match(await getUI().locator('.lms-table-wrap').innerText(), /after-startup.md/); await close();
  assert(remote.calls.every(call => call.method === 'GET'));
  report.checks.push('Real post-startup create events remain observed and included in the read-only plan');
}
