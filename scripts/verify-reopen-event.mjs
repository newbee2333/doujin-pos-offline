import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
context.on('dialog', dialog => dialog.accept());
await context.addInitScript(() => { window.promptCalls = 0; window.prompt = () => { window.promptCalls++; return null; }; });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(process.env.SMOKE_BASE ?? 'http://127.0.0.1:5201/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
  await page.locator('.sidebar').waitFor();
  const id = await page.evaluate(async () => {
    const { createEvent } = await import('/src/services/events.ts');
    const { db } = await import('/src/db/client.ts');
    const { useApp } = await import('/src/store.ts');
    const { setPin } = await import('/src/services/system.ts');
    const id = await createEvent({ name: '重新开场验证', currency: 'CNY' });
    await db.tx([{ t: 'run', sql: "UPDATE events SET status='closed' WHERE id=?", params: [id] }]);
    await setPin('1234');
    useApp.getState().setCurrentEvent(id); useApp.getState().unlockStaff();
    return id;
  });
  const status = () => page.evaluate(async id => (await (await import('/src/db/client.ts')).db.read('SELECT status FROM events WHERE id=?', [id]))[0].status, id);
  await page.locator('.sidebar a[href="/staff/events"]').click();
  await page.getByRole('button', { name: '重新打开', exact: true }).tap();
  if (process.env.REPRO_BASELINE === '1') {
    assert.equal(await page.evaluate(() => window.promptCalls), 1);
    assert.equal(await status(), 'closed');
    console.log('REPRODUCED: suppressed native prompt leaves event closed with no visible feedback');
  } else {
    const modal = page.locator('.modal');
    await modal.waitFor();
    assert.equal(await page.evaluate(() => window.promptCalls), 0);
    const confirm = modal.getByRole('button', { name: '确认重新打开', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await modal.getByRole('button', { name: '取消', exact: true }).tap();
    assert.equal(await status(), 'closed');
    await page.getByRole('button', { name: '重新打开', exact: true }).tap();
    await page.getByLabel('重新打开原因').fill('  补录现场订单  ');
    await confirm.tap();
    await modal.waitFor({ state: 'detached' });
    assert.equal(await status(), 'active');
    const audit = await page.evaluate(async id => (await (await import('/src/db/client.ts')).db.read("SELECT detail_json FROM audit_log WHERE action='event.reopen' AND entity_id=?", [id])), id);
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].detail_json).reason, '补录现场订单');
    const other = await page.evaluate(async () => {
      const { createEvent } = await import('/src/services/events.ts');
      const { db } = await import('/src/db/client.ts');
      const { useApp } = await import('/src/store.ts');
      const id = await createEvent({ name: '不能同时开场', currency: 'CNY' });
      await db.tx([{ t: 'run', sql: "UPDATE events SET status='closed' WHERE id=?", params: [id] }]);
      useApp.getState().setCurrentEvent(id);
      return id;
    });
    await page.getByRole('button', { name: '重新打开', exact: true }).tap();
    await page.getByLabel('重新打开原因').fill('继续营业');
    await confirm.tap();
    await modal.getByText(/已有进行中的展会/).waitFor();
    assert.equal(await page.getByLabel('重新打开原因').inputValue(), '继续营业');
    assert.equal(await page.evaluate(async id => (await (await import('/src/db/client.ts')).db.read('SELECT status FROM events WHERE id=?', [id]))[0].status, other), 'closed');
    await modal.getByRole('button', { name: '取消', exact: true }).tap();
    assert.deepEqual(errors, []);
    console.log('PASS: suppressed prompt, required reason, cancel, reopen, audit and active-event conflict feedback');
  }
} finally { await browser.close(); }
