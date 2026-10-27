import { test, expect } from '@playwright/test';

test.describe('Dashboard E2E Workflow', () => {
  // Use a fixed email/password for testing, or mock the Supabase auth.
  // In a real project, we'd use seed data from Supabase local development.
  const TEST_USER = 'lecturer@example.com';
  const TEST_PASS = 'password123';

  test('Login -> Create Course -> Start Session', async ({ page }) => {
    // 1. Login
    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_USER);
    await page.fill('input[type="password"]', TEST_PASS);
    await page.click('button[type="submit"]');

    // Wait for navigation to dashboard
    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('h1')).toContainText('Dashboard');

    // 2. Create Course
    await page.click('text="Create Course"');
    
    // The modal should appear
    await expect(page.locator('text="Create New Course"')).toBeVisible();
    await page.fill('input[placeholder="e.g. CS101"]', 'TEST101');
    await page.fill('input[placeholder="e.g. Intro to Computer Science"]', 'Playwright Test Course');
    await page.click('button:has-text("Create Course")');

    // Wait for course to appear in the list and click it
    await expect(page.locator('text="TEST101"')).toBeVisible();
    await page.click('text="TEST101"');

    // Wait for course detail page
    await expect(page.locator('h1')).toContainText('TEST101');

    // 3. Start Session
    await page.click('button:has-text("Start Session")');
    
    // Fill session duration
    await page.fill('input[type="number"]', '15'); // 15 minutes
    await page.click('button:has-text("Start Now")');

    // Wait to be redirected to the active session page
    await expect(page).toHaveURL(/\/dashboard\/sessions\/.+/);
    await expect(page.locator('text="Active Session"')).toBeVisible();
    await expect(page.locator('text="Waiting for students"')).toBeVisible();
  });
});
