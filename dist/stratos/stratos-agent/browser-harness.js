import { chromium } from 'playwright-core';
import fs from 'fs/promises';
import path from 'path';

/**
 * BrowserHarness manages local Chromium instances or connects to existing instances via CDP.
 * It facilitates session state persistence (cookies, localStorage) to maintain long-lived residential sessions.
 */
export class BrowserHarness {
  /**
   * @param {Object} options
   * @param {string} [options.userDataDir] - Path to the persistent Chrome user profile directory.
   * @param {string} [options.executablePath] - Path to the Chrome/Chromium executable.
   * @param {string} [options.cdpEndpoint] - Chrome DevTools Protocol (CDP) websocket URL.
   * @param {string} [options.sessionFilePath] - Path to load/save session state (cookies & storage).
   * @param {boolean} [options.headless=false] - Whether to run the browser in headless mode.
   * @param {Array<string>} [options.args] - Additional command line arguments to pass to the browser.
   */
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || path.join(process.cwd(), '.stratos-profile');
    this.executablePath = options.executablePath || null;
    this.cdpEndpoint = options.cdpEndpoint || null;
    this.sessionFilePath = options.sessionFilePath || path.join(process.cwd(), '.stratos-session.json');
    this.headless = options.headless !== undefined ? options.headless : false;
    this.args = options.args || [
      '--disable-blink-features=AutomationControlled',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--no-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list'
    ];

    this.browser = null;
    this.context = null;
  }

  /**
   * Launches a new browser instance or connects to an existing one via CDP.
   * Restores any saved session state if available.
   * @returns {Promise<import('playwright-core').BrowserContext>}
   */
  async launch() {
    if (this.cdpEndpoint) {
      console.log(`[BrowserHarness] Connecting to existing browser via CDP: ${this.cdpEndpoint}`);
      this.browser = await chromium.connectOverCDP(this.cdpEndpoint);
      // CDP connections expose contexts directly or allow creating new ones
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.context = contexts[0];
      } else {
        this.context = await this.browser.newContext();
      }
    } else {
      console.log(`[BrowserHarness] Launching local persistent browser at: ${this.userDataDir}`);
      
      // Ensure the user data directory exists
      await fs.mkdir(this.userDataDir, { recursive: true });

      const launchOptions = {
        headless: this.headless,
        args: this.args,
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        acceptDownloads: true
      };

      if (this.executablePath) {
        launchOptions.executablePath = this.executablePath;
      }

      this.context = await chromium.launchPersistentContext(this.userDataDir, launchOptions);
    }

    // Try to load cookies and storage state if a session file exists
    await this.loadSession();

    return this.context;
  }

  /**
   * Saves the current browser context session state (cookies, localStorage) to a file.
   * @param {import('playwright-core').Page} [page] - Optional page to capture localStorage from.
   */
  async saveSession(page = null) {
    if (!this.context) {
      throw new Error('[BrowserHarness] Cannot save session: No active browser context.');
    }

    console.log(`[BrowserHarness] Saving session state to: ${this.sessionFilePath}`);
    const cookies = await this.context.cookies();
    let localStorageData = {};

    if (page) {
      try {
        localStorageData = await page.evaluate(() => {
          const items = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            items[key] = localStorage.getItem(key);
          }
          return items;
        });
      } catch (err) {
        console.warn('[BrowserHarness] Failed to retrieve localStorage from page:', err.message);
      }
    }

    const sessionState = {
      timestamp: new Date().toISOString(),
      cookies,
      localStorage: localStorageData
    };

    await fs.mkdir(path.dirname(this.sessionFilePath), { recursive: true });
    await fs.writeFile(this.sessionFilePath, JSON.stringify(sessionState, null, 2), 'utf-8');
    console.log('[BrowserHarness] Session state successfully persisted.');
  }

  /**
   * Loads cookies and localStorage into the active browser context.
   */
  async loadSession() {
    if (!this.context) return;

    try {
      await fs.access(this.sessionFilePath);
    } catch {
      console.log('[BrowserHarness] No existing session file found. Starting with a fresh session.');
      return;
    }

    try {
      const data = await fs.readFile(this.sessionFilePath, 'utf-8');
      const sessionState = JSON.parse(data);

      if (sessionState.cookies && sessionState.cookies.length > 0) {
        console.log(`[BrowserHarness] Restoring ${sessionState.cookies.length} cookies...`);
        await this.context.addCookies(sessionState.cookies);
      }

      // We apply localStorage by injecting it on page creation or on first navigation
      this.context.on('page', async (page) => {
        page.on('domcontentloaded', async () => {
          if (sessionState.localStorage && Object.keys(sessionState.localStorage).length > 0) {
            try {
              await page.evaluate((storageData) => {
                Object.entries(storageData).forEach(([key, val]) => {
                  localStorage.setItem(key, val);
                });
              }, sessionState.localStorage);
            } catch (err) {
              // Ignore frames/about:blank context errors
            }
          }
        });
      });

      console.log('[BrowserHarness] Session state successfully restored.');
    } catch (err) {
      console.error('[BrowserHarness] Failed to restore session state:', err);
    }
  }

  /**
   * Closes the browser context and the browser instance.
   */
  async close() {
    console.log('[BrowserHarness] Shutting down browser context...');
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
