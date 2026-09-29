import { test, expect } from '@playwright/test';

test('recording settings persist and the Runs view preserves a configuration draft', async ({ page }) => {
  await page.goto('/#observability');
  await expect(page.getByLabel('Record with asciinema')).not.toBeChecked();
  await page.getByLabel('Record with asciinema').check();
  await page.getByLabel('Terminal columns').fill('90');
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page.getByText('Configuration has unsaved changes. This view reads the saved data directory.')).toBeVisible();
  await page.getByRole('link', { name: 'Recording settings' }).click();
  await expect(page.getByLabel('Record with asciinema')).toBeChecked();
  await expect(page.getByLabel('Terminal columns')).toHaveValue('90');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Configuration saved');
  await page.reload();
  await expect(page.getByLabel('Record with asciinema')).toBeChecked();
  await expect(page.getByLabel('Terminal columns')).toHaveValue('90');
});

test('real worker attempts expose commands, failures, metrics, feedback and a playable cast', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/#runs');
  await expect(page.getByRole('heading', { name: 'Runs.' })).toBeVisible();
  await expect(page.locator('.run-table-row')).toHaveCount(3);
  await page.getByLabel('Filter runs').selectOption('dead');
  await expect(page.locator('.run-table-row')).toHaveCount(1);
  await page.getByRole('link', { name: 'Inspect job 2: Handle a model outage' }).click();
  await expect(page.getByText('Fixture model is unavailable').first()).toBeVisible();
  await expect(page.getByText('Model call failed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Replay' }).click();
  await expect(page.getByRole('heading', { name: 'No recording for this attempt' })).toBeVisible();

  await page.goto('/#runs?job=1');
  await expect(page.locator('.run-metrics')).toContainText('70 / 23');
  await expect(page.locator('.run-metrics')).toContainText('1 failed or interrupted');
  await expect(page.getByText('Command 1 finished', { exact: true })).toBeVisible();
  await expect(page.locator('.event-output--error')).toContainText('missing.txt');
  await expect(page.getByRole('heading', { name: 'GitHub feedback for this job' })).toBeVisible();
  const exportUrl = await page.getByRole('link', { name: 'Export events' }).getAttribute('href');
  const exported = await request.get(exportUrl!);
  expect(exported.status()).toBe(200);
  expect((await exported.text()).split('\n').filter(Boolean).map(line => JSON.parse(line).type)).toContain('capability-end');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const terminal = page.locator('.terminal-player');
  await expect(terminal.locator('.ap-wrapper')).toBeVisible();
  await expect(terminal.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await terminal.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(terminal).toContainText('Fixed addition and inspected the updated source.');
  await expect(terminal.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const progress = terminal.locator('.ap-bar');
  await progress.click({ position: { x: 1, y: 5 } });
  await expect(terminal).not.toContainText('Fixed addition and inspected the updated source.');
  await page.getByLabel('Playback speed').selectOption('0.5');
  await expect(terminal.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await terminal.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(terminal.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await terminal.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(terminal.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const castUrl = await page.getByRole('link', { name: 'Download .cast' }).getAttribute('href');
  const cast = await request.get(castUrl!);
  const lines = (await cast.text()).trim().split('\n').map(line => JSON.parse(line));
  expect(lines[0].version).toBe(2);
  expect(lines.some(line => Array.isArray(line) && line[1] === 'm')).toBe(true);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(terminal.locator('.ap-wrapper')).toHaveCount(1);
  await expect(terminal.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('runs, terminal playback and recording settings fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#runs');
  await expect(page.locator('.run-table-row')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Inspect job 1: Fix addition in math.ts' }).click();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.locator('.ap-wrapper')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Recording settings' }).click();
  await expect(page.getByLabel('Record with asciinema')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('polling preserves history through a read failure and resumes from the event cursor', async ({ page, request }) => {
  const fixture = await (await request.get('/api/runs/1')).json();
  const nextId = fixture.nextCursor + 1;
  let reads = 0;
  await page.route('**/api/runs/1?*', async route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after'));
    if (++reads === 2) { await route.fulfill({ status: 503, json: { error: 'History temporarily unavailable.' } }); return; }
    await route.fulfill({ json: after === 0 ? fixture : { ...fixture,
      events: after < nextId ? [{ id: nextId, type: 'phase', at: Date.now(), elapsedMs: 1000,
        data: { phase: 'polling recovered' } }] : [], nextCursor: nextId } });
  });
  await page.goto('/#runs?job=1');
  await expect(page.getByText('Command 1 finished', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Showing the last successful read.');
  await expect(page.getByText('Command 1 finished', { exact: true })).toBeVisible();
  await expect(page.getByText('polling recovered', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeVisible();
  await expect(page.getByText('Command 1 finished', { exact: true })).toHaveCount(1);
});
