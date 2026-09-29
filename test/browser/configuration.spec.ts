import { test, expect } from '@playwright/test';

test.describe.serial('configuration console', () => {
  test('saves across tabs, hides secrets after reload, and checks GitHub access', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Configuration.' })).toBeVisible();
    await page.getByRole('button', { name: 'Check configuration' }).click();
    await expect(page.getByText('Enter a repository', { exact: true })).toBeVisible();
    await page.getByLabel('Repository', { exact: true }).fill('example/repository');
    await page.getByLabel('Access token', { exact: true }).check();
    await page.getByLabel('GitHub token', { exact: true }).fill('browser-test-github-secret');
    await page.getByLabel('Webhook secret', { exact: true }).fill('browser-test-webhook-secret');
    await page.getByText('Cloudflare relay · optional', { exact: true }).click();
    await page.getByLabel('Relay URL', { exact: true }).fill('https://relay.example');
    await page.getByLabel('Cloudflare account ID', { exact: true }).fill('a'.repeat(32));
    await page.getByLabel('Cloudflare queue ID', { exact: true }).fill('b'.repeat(32));
    await page.getByLabel('Cloudflare API token', { exact: true }).fill('browser-fixture-cloudflare-api-token');
    await page.getByLabel('Relay access token', { exact: true }).fill('browser-fixture-relay-token-with-thirty-two-characters');
    await page.getByRole('link', { name: 'Triggers', exact: true }).first().click();
    await page.getByLabel('Required labels').fill('agent, ready');
    await page.getByRole('link', { name: 'Model & runtime', exact: true }).click();
    await page.getByLabel('Provider', { exact: true }).selectOption('openai-compatible');
    await page.getByLabel('Model ID', { exact: true }).fill('local-test-model');
    await page.getByLabel('API base URL', { exact: true }).fill('http://127.0.0.1:9999/v1');
    await page.getByRole('button', { name: 'Check configuration' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration looks valid');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration saved');
    await page.reload();
    await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('local-test-model');
    await page.getByRole('link', { name: 'GitHub', exact: true }).click();
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('example/repository');
    await expect(page.getByLabel('GitHub token', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('GitHub token', { exact: true })).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    await expect(page.getByLabel('Webhook secret', { exact: true })).toHaveValue('');
    await page.getByText('Cloudflare relay · optional', { exact: true }).click();
    await expect(page.getByLabel('Relay URL', { exact: true })).toHaveValue('https://relay.example');
    await expect(page.getByLabel('Cloudflare API token', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Relay access token', { exact: true })).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status')).toContainText('GitHub repository read access verified');
    await page.getByRole('button', { name: 'Environment', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('GITHUB_TOKEN=<redacted>');
    await expect(dialog).not.toContainText('browser-test-github-secret');
    await expect(dialog).not.toContainText('browser-test-webhook-secret');
    await expect(dialog).toContainText('CLOUDFLARE_API_TOKEN=<redacted>');
    await expect(dialog).toContainText('CLOUDFLARE_RELAY_TOKEN=<redacted>');
    await expect(dialog).not.toContainText('browser-fixture-cloudflare-api-token');
    await expect(dialog).not.toContainText('browser-fixture-relay-token');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Environment', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'Triggers', exact: true }).first().click();
    await expect(page.getByLabel('Required labels')).toHaveValue('agent, ready');
    expect(errors).toEqual([]);
  });

  test('keeps draft edits through navigation, resets auth mode on discard, and explicitly removes secrets', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'GitHub App', exact: true }).check();
    await page.getByLabel('Client ID', { exact: true }).fill('Iv1.draft');
    await page.getByLabel('Private key path', { exact: true }).fill('/tmp/draft.pem');
    await page.getByRole('link', { name: 'Tools', exact: true }).click();
    await page.getByLabel('Extension module').fill('./examples/extensions.mjs');
    await page.getByRole('link', { name: 'GitHub', exact: true }).click();
    await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('Iv1.draft');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByLabel('GitHub token', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove saved GitHub token' }).click();
    await expect(page.getByLabel('GitHub token', { exact: true })).toHaveAttribute('placeholder', 'Will be removed when saved');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration saved');
    await page.reload();
    await page.getByLabel('Access token', { exact: true }).check();
    await expect(page.getByLabel('GitHub token', { exact: true })).toHaveAttribute('placeholder', 'Enter a secret');
  });

  test('a stale tab cannot overwrite a newer save', async ({ page, context }) => {
    await page.goto('/');
    await page.getByLabel('Repository', { exact: true }).fill('example/stale');
    const other = await context.newPage();
    await other.goto('/');
    await other.getByLabel('Repository', { exact: true }).fill('example/current');
    await other.getByRole('button', { name: 'Save changes' }).click();
    await expect(other.getByRole('status')).toContainText('Configuration saved');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration changed');
    await page.getByRole('button', { name: 'Reload saved configuration' }).click();
    await page.getByRole('button', { name: 'Reload from file' }).click();
    await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('example/current');
    await other.close();
  });

  test('mobile navigation and all settings fit the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    for (const section of ['GitHub', 'Triggers', 'Model & runtime', 'Tools']) {
      await page.getByRole('link', { name: section, exact: true }).first().click();
      if (section === 'GitHub') await page.getByText('Cloudflare relay · optional', { exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByRole('link', { name: 'Setup guide', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'A small setup. A capable agent.' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('saves API polling without a webhook secret and shows the polling setup guide', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Access token', { exact: true }).check();
    await page.getByLabel('GitHub token', { exact: true }).fill('browser-polling-fixture');
    await page.getByRole('button', { name: 'Remove saved Webhook secret', exact: true }).click();
    await page.getByLabel('Event source', { exact: true }).selectOption('poll');
    await expect(page.getByLabel('Webhook secret', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('GitHub poll interval', { exact: true })).toHaveAttribute('min', '15000');
    await page.getByLabel('GitHub poll interval', { exact: true }).fill('14999');
    await page.getByRole('button', { name: 'Check configuration' }).click();
    await expect(page.locator('#GITHUB_POLL_INTERVAL_MS-hint')).toHaveText('Enter an integer from 15000 to 3600000');
    await page.getByLabel('GitHub poll interval', { exact: true }).fill('15000');
    await page.getByRole('button', { name: 'Check configuration' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration looks valid');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Configuration saved');
    await page.reload();
    await expect(page.getByLabel('Event source', { exact: true })).toHaveValue('poll');
    await expect(page.getByLabel('GitHub poll interval', { exact: true })).toHaveValue('15000');
    await page.getByRole('link', { name: 'Triggers', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Issue discovery', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Setup guide', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: '02 / Poll the GitHub API', exact: true })).toBeVisible();
  });
});
