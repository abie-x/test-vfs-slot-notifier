/**
 * Campus Slot Notifier — Production (Fully Automated)
 *
 * Proven architecture with complete automation:
 *   1. Launch Chrome with --remote-debugging-port
 *   2. CDP connects → navigates to login → auto-fills email + password
 *   3. CDP disconnects → Login Turnstile passes ✓ (7s wait)
 *   4. Disconnect/reconnect cycle: Check button every 60s (5 checks max)
 *   5. Auto-clicks Sign In button when enabled
 *   6. CDP disconnects → OTP Turnstile passes ✓ (8s wait)
 *   7. Fetches OTP from Gmail API automatically (while disconnected)
 *   8. CDP reconnects → auto-fills OTP → waits 2s
 *   9. Disconnect/reconnect cycle: Check Submit button every 60s (5 checks max)
 *   10. Auto-clicks Submit button when enabled
 *   11. Redirects to dashboard → manual navigation to booking page
 *   12. Polling runs via sub-category cycling every 30s
 *   13. Slot changes logged (Telegram notifications in Phase 6)
 *
 * Turnstile Strategy: Disconnect/Reconnect Cycle
 * - Initial disconnect: 7s (login) / 8s (OTP) for Turnstile to render
 * - Check button status every 60 seconds (5 checks total)
 * - Disconnect between checks (gives Turnstile 60s windows to work)
 * - Reconnect briefly (1-2s) only to check button status
 * - Total patience: ~247 seconds before reload retry
 * - One reload retry, then exits if still fails
 *
 * Happy Path: Fast (~7-10s if Turnstile passes quickly)
 * Unhappy Path: Patient (up to 247s with minimal CDP interference)
 *
 * Usage: npm start
 */

import 'dotenv/config';
import * as readline from 'readline';
import { logger } from './utils/logger';
import { POLL_USER_DATA_DIR, REMOTE_DEBUG_PORT } from './auth/browser';
import { spawn } from 'child_process';
import { waitForOtp } from './utils/gmail';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CDP = require('chrome-remote-interface');

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);

const SUB_CATEGORIES = [
  'Long Stay',
  'Short Stay - Business',
  'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function connectCDP(filterUrl?: string): Promise<any> {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await CDP.List({ port: REMOTE_DEBUG_PORT });
      const page = filterUrl
        ? targets.find((t: any) => t.type === 'page' && t.url?.includes(filterUrl) && !t.url?.includes('devtools'))
        : targets.find((t: any) => t.type === 'page' && !t.url?.includes('devtools'));
      if (page) {
        logger.info({ url: page.url }, 'CDP connected');
        return await CDP({ port: REMOTE_DEBUG_PORT, target: page.id });
      }
    } catch { /* retry */ }
    await sleep(1000);
  }
  throw new Error('Could not connect CDP');
}

async function selectSubCategory(Runtime: any, optionText: string): Promise<boolean> {
  const script = `
    (async () => {
      try {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 3) return { ok: false, error: 'mat-select count: ' + selects.length };
        selects[2].click();
        await new Promise(r => setTimeout(r, 800));
        const options = document.querySelectorAll('mat-option');
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(optionText)});
        if (!target) return { ok: false, error: 'Option not found' };
        target.click();
        await new Promise(r => setTimeout(r, 500));
        return { ok: true };
      } catch(e) { return { ok: false, error: String(e) }; }
    })()
  `;
  const result = await Runtime.evaluate({ expression: script, awaitPromise: true, returnByValue: true, timeout: 10_000 });
  const val = result.result?.value as { ok: boolean; error?: string };
  if (!val?.ok) { logger.warn({ error: val?.error }, 'selectSubCategory failed'); return false; }
  logger.info({ selected: optionText }, '✓ Sub-category selected');
  return true;
}

async function main(): Promise<void> {
  logger.info('Campus Slot Notifier — Production (Fully Automated)');
  logger.info('═══════════════════════════════════════════════════════');

  const email    = process.env.VFS_EMAIL ?? '';
  const password = process.env.VFS_PASSWORD ?? '';
  if (!email || !password) { logger.error('VFS_EMAIL and VFS_PASSWORD must be set'); process.exit(1); }

  // ── Step 1: Launch Chrome ────────────────────────────────────────────────
  logger.info('Launching Chrome...');
  const chromeProc = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${POLL_USER_DATA_DIR}`,
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    VFS_LOGIN_URL,
  ], { detached: false, stdio: 'ignore' });
  await sleep(3000);

  // ── Step 2: Connect CDP and navigate to VFS login ───────────────────────
  logger.info('Connecting CDP...');
  let client = await connectCDP();
  let { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  // Navigate to VFS login (in case we're on chrome:// page)
  logger.info('Navigating to VFS login...');
  await Page.navigate({ url: VFS_LOGIN_URL });
  await sleep(3000);

  // Wait for form
  logger.info('Waiting for login form...');
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const check = await Runtime.evaluate({
      expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
      returnByValue: true,
    });
    if (check.result?.value === true) { logger.info('✓ Form ready'); break; }
    if (i === 19) logger.warn('Form timeout — attempting fill anyway');
  }

  // Fill credentials using Angular-compatible setter
  logger.info('Filling credentials...');
  const fillResult = await Runtime.evaluate({
    expression: `
      (async () => {
        const email = document.querySelector('#email');
        const pass  = document.querySelector('#password');
        if (!email || !pass) return { ok: false, error: 'Fields not found' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(email, ${JSON.stringify(email)});
        email.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        setter?.call(pass, ${JSON.stringify(password)});
        pass.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, emailValue: email.value, passLength: pass.value.length };
      })()
    `,
    awaitPromise: true, returnByValue: true, timeout: 10_000,
  });
  logger.info({ result: fillResult.result?.value }, 'Fill result');

  // ── Step 3: Disconnect CDP before Turnstile ──────────────────────────────
  logger.info('Disconnecting CDP before Turnstile renders...');
  await client.close();
  logger.info('✓ CDP disconnected — Turnstile should pass now');
  await sleep(7000); // Wait for Turnstile to render and complete

  // ── Step 4: Check Sign In button with disconnect/reconnect cycle ───────
  logger.info('Checking Sign In button (disconnect/reconnect cycle, up to 4 minutes)...');
  let clicked = false;
  const maxChecks = 5; // Check at 7s, 67s, 127s, 187s, 247s
  const disconnectInterval = 60; // 60 seconds between checks
  
  for (let checkNum = 1; checkNum <= maxChecks; checkNum++) {
    // Reconnect CDP to check button status
    logger.info(`Reconnecting CDP for check #${checkNum}...`);
    client = await connectCDP('vfsglobal.com');
    ({ Runtime } = client);
    await client.Runtime.enable();
    
    const btnResult = await Runtime.evaluate({
      expression: `
        (() => {
          const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
          if (!btn) return { found: false };
          const disabled = btn.hasAttribute('disabled');
          if (!disabled) btn.click();
          return { found: true, disabled, clicked: !disabled };
        })()
      `,
      returnByValue: true,
    });
    const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
    
    if (btn?.clicked) {
      clicked = true;
      logger.info(`✓ Sign In button enabled and clicked (check #${checkNum})`);
      break;
    }
    
    if (btn?.disabled) {
      const elapsedTime = 7 + (checkNum - 1) * disconnectInterval;
      logger.info(`[Check #${checkNum} at ${elapsedTime}s] Sign In: disabled, waiting for Turnstile...`);
      
      // If not the last check, disconnect and wait
      if (checkNum < maxChecks) {
        logger.info(`Disconnecting CDP for ${disconnectInterval}s (giving Turnstile space to work)...`);
        await client.close();
        await sleep(disconnectInterval * 1000);
      }
    } else if (!btn?.found) {
      logger.warn(`[Check #${checkNum}] Sign In button not found`);
      if (checkNum < maxChecks) {
        await client.close();
        await sleep(disconnectInterval * 1000);
      }
    }
  }

  if (!clicked) {
    logger.warn('Sign In button still disabled after 5 checks (~247s) — Turnstile may have failed');
    logger.warn('Reloading page to retry (one time)...');
    
    // Ensure CDP is connected for reload
    if (!client || !client.Page) {
      client = await connectCDP('vfsglobal.com');
      ({ Page, Runtime } = client);
      await Page.enable();
      await Runtime.enable();
    }
    
    // Reload and retry the entire login flow
    await client.Page.enable();
    await client.Page.reload();
    await sleep(3000);
    
    // Wait for form
    logger.info('Waiting for login form after reload...');
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const check = await Runtime.evaluate({
        expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
        returnByValue: true,
      });
      if (check.result?.value === true) break;
    }
    
    // Re-fill credentials
    logger.info('Re-filling credentials...');
    await Runtime.evaluate({
      expression: `
        (async () => {
          const email = document.querySelector('#email');
          const pass  = document.querySelector('#password');
          if (!email || !pass) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(email, ${JSON.stringify(email)});
          email.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 300));
          setter?.call(pass, ${JSON.stringify(password)});
          pass.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    
    // Disconnect for Turnstile
    logger.info('Disconnecting CDP for Turnstile (retry)...');
    await client.close();
    await sleep(7000);
    
    // Reconnect
    logger.info('Reconnecting CDP (retry)...');
    client = await connectCDP('vfsglobal.com');
    ({ Runtime } = client);
    await Runtime.enable();
    
    // Try clicking Sign In again with disconnect/reconnect cycle
    logger.info('Checking Sign In button (retry, disconnect/reconnect cycle)...');
    const retryMaxChecks = 5;
    const retryDisconnectInterval = 60;
    
    for (let checkNum = 1; checkNum <= retryMaxChecks; checkNum++) {
      // Reconnect CDP to check button status
      logger.info(`Reconnecting CDP for retry check #${checkNum}...`);
      client = await connectCDP('vfsglobal.com');
      ({ Runtime } = client);
      await Runtime.enable();
      
      const btnResult = await Runtime.evaluate({
        expression: `
          (() => {
            const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
            if (!btn) return { found: false };
            const disabled = btn.hasAttribute('disabled');
            if (!disabled) btn.click();
            return { found: true, disabled, clicked: !disabled };
          })()
        `,
        returnByValue: true,
      });
      const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
      
      if (btn?.clicked) {
        clicked = true;
        logger.info(`✓ Sign In clicked after reload (retry check #${checkNum})`);
        break;
      }
      
      if (btn?.disabled) {
        const elapsedTime = 7 + (checkNum - 1) * retryDisconnectInterval;
        logger.info(`[Retry check #${checkNum} at ${elapsedTime}s] Sign In: disabled, waiting...`);
        
        if (checkNum < retryMaxChecks) {
          logger.info(`Disconnecting CDP for ${retryDisconnectInterval}s...`);
          await client.close();
          await sleep(retryDisconnectInterval * 1000);
        }
      }
    }
    
    if (!clicked) {
      logger.error('Sign In still failed after reload — manual intervention required');
      process.exit(1);
    }
  }

  // ── Step 5: Wait for OTP screen and disconnect CDP ──────────────────────
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Waiting for OTP screen...');
  logger.info('════════════════════════════════════════════════════');

  // Wait for OTP screen to appear
  logger.info('Waiting for OTP input field...');
  let otpFieldFound = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const check = await Runtime.evaluate({
      expression: `
        (() => {
          const inputs = document.querySelectorAll('input');
          const otpInput = Array.from(inputs).find(el =>
            el.placeholder?.includes('*') ||
            document.body.innerText.includes('one time password')
          );
          return !!otpInput;
        })()
      `,
      returnByValue: true,
    });
    if (check.result?.value === true) {
      otpFieldFound = true;
      logger.info('✓ OTP screen detected');
      break;
    }
  }

  if (!otpFieldFound) {
    logger.error('OTP screen not detected — login may have failed');
    logger.error('Please check the browser and enter OTP manually if needed');
    await waitForEnter('\n>>> Press ENTER after completing OTP manually <<<\n');
  } else {
    // ── Step 6: Disconnect CDP before OTP Turnstile ─────────────────────────
    logger.info('Disconnecting CDP before OTP Turnstile renders...');
    await client.close();
    logger.info('✓ CDP disconnected — OTP Turnstile should pass now');
    await sleep(8000); // Give Turnstile more time to render and complete (increased from 5s)

    // ── Step 7: Fetch OTP from Gmail while CDP is disconnected ──────────────
    logger.info('');
    logger.info('════════════════════════════════════════════════════');
    logger.info('  Fetching OTP from Gmail...');
    logger.info('  (checking Gmail API automatically)');
    logger.info('════════════════════════════════════════════════════');

    let otp = await waitForOtp(2 * 60 * 1000);

    if (!otp) {
      logger.warn('OTP not received within 2 minutes — waiting 2 more minutes...');
      logger.info('(VFS sometimes delays OTP delivery)');
      otp = await waitForOtp(2 * 60 * 1000);
    }

    if (!otp) {
      logger.error('OTP still not received after 4 minutes total');
      logger.error('This may indicate an issue with VFS OTP delivery');
      logger.info('');
      logger.info('Attempting to reload and retry...');
      
      // Reconnect CDP to reload
      logger.info('Reconnecting CDP...');
      client = await connectCDP('vfsglobal.com');
      ({ Page, Runtime } = client);
      await Page.enable();
      await Runtime.enable();
      
      // Check which screen we're on
      const screenCheck = await Runtime.evaluate({
        expression: `
          (() => {
            const url = location.href;
            const hasEmailField = !!document.querySelector('#email');
            const hasOtpField = !!Array.from(document.querySelectorAll('input')).find(el =>
              el.placeholder?.includes('*') || el.type === 'password'
            );
            const hasDashboard = url.includes('application-detail') || document.body.innerText.includes('Start New Booking');
            
            if (hasEmailField) return 'login';
            if (hasOtpField) return 'otp';
            if (hasDashboard) return 'dashboard';
            return 'unknown';
          })()
        `,
        returnByValue: true,
      });
      const currentScreen = String(screenCheck.result?.value ?? 'unknown');
      logger.info({ screen: currentScreen }, 'Current screen detected');
      
      if (currentScreen === 'login') {
        logger.info('On login screen — reloading page to retry...');
        await Page.reload();
        await sleep(3000);
        
        // Re-fill credentials and continue
        logger.info('Re-filling credentials...');
        await Runtime.evaluate({
          expression: `
            (async () => {
              const email = document.querySelector('#email');
              const pass  = document.querySelector('#password');
              if (!email || !pass) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(email, ${JSON.stringify(email)});
              email.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
              setter?.call(pass, ${JSON.stringify(password)});
              pass.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });
        
        // Disconnect for Turnstile
        await client.close();
        await sleep(7000);
        
        // Reconnect and click Sign In
        client = await connectCDP('vfsglobal.com');
        ({ Runtime } = client);
        await Runtime.enable();
        
        // Wait for and click Sign In
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const clicked = await Runtime.evaluate({
            expression: `
              (() => {
                const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
                if (btn && !btn.hasAttribute('disabled')) {
                  btn.click();
                  return true;
                }
                return false;
              })()
            `,
            returnByValue: true,
          });
          if (clicked.result?.value === true) {
            logger.info('✓ Sign In clicked after reload');
            break;
          }
        }
        
        // Wait for OTP screen
        await sleep(3000);
        await client.close();
        await sleep(8000);
        
        // Try fetching OTP again
        logger.info('Fetching OTP again after reload...');
        otp = await waitForOtp(2 * 60 * 1000);
      } else if (currentScreen === 'otp') {
        logger.info('Still on OTP screen — reloading page (will go to login)...');
        await Page.reload();
        await sleep(3000);
        
        logger.info('Reloaded to login screen — starting full login process again...');
        
        // Dismiss cookie banner
        await Runtime.evaluate({
          expression: `
            const btn = Array.from(document.querySelectorAll('button'))
              .find(b => b.textContent.trim() === 'Accept All Cookies');
            if (btn) btn.click();
          `,
        });
        await sleep(1000);
        
        // Wait for form
        logger.info('Waiting for login form...');
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const check = await Runtime.evaluate({
            expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
            returnByValue: true,
          });
          if (check.result?.value === true) break;
        }
        
        // Fill credentials
        logger.info('Filling credentials...');
        await Runtime.evaluate({
          expression: `
            (async () => {
              const email = document.querySelector('#email');
              const pass  = document.querySelector('#password');
              if (!email || !pass) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(email, ${JSON.stringify(email)});
              email.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
              setter?.call(pass, ${JSON.stringify(password)});
              pass.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });
        
        // Disconnect for login Turnstile
        logger.info('Disconnecting CDP for login Turnstile...');
        await client.close();
        await sleep(7000);
        
        // Reconnect and wait for Sign In button
        logger.info('Reconnecting CDP...');
        client = await connectCDP('vfsglobal.com');
        ({ Runtime } = client);
        await Runtime.enable();
        
        // Wait for and click Sign In (EXACT same logic as initial login)
        logger.info('Waiting for Sign In button...');
        let signInClicked = false;
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const btnResult = await Runtime.evaluate({
            expression: `
              (() => {
                const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
                if (!btn) return { found: false };
                const disabled = btn.hasAttribute('disabled');
                if (!disabled) btn.click();
                return { found: true, disabled, clicked: !disabled };
              })()
            `,
            returnByValue: true,
          });
          const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
          
          if (btn?.clicked) {
            signInClicked = true;
            logger.info('✓ Sign In clicked');
            break;
          }
          
          // After 7 seconds, check Turnstile if button still disabled
          if (i === 6 && btn?.disabled) {
            logger.warn('Sign In still disabled — checking Turnstile...');
            const tsCheck = await Runtime.evaluate({
              expression: `
                (() => {
                  const checkbox = document.querySelector('input[type="checkbox"][name*="cf-turnstile"], input[type="checkbox"][id*="turnstile"]');
                  const iframe = document.querySelector('iframe[src*="turnstile"]');
                  return {
                    checkboxFound: !!checkbox,
                    checkboxChecked: checkbox?.checked || false,
                    iframeFound: !!iframe,
                    turnstileVisible: !!document.querySelector('[id*="turnstile"], [class*="turnstile"]')
                  };
                })()
              `,
              returnByValue: true,
            });
            const loginTs = tsCheck.result?.value as any;
            
            if (loginTs?.turnstileVisible && !loginTs?.checkboxChecked) {
              logger.warn('Turnstile not checked — clicking checkbox...');
              await Runtime.evaluate({
                expression: `
                  (() => {
                    const checkbox = document.querySelector('input[type="checkbox"][name*="cf-turnstile"], input[type="checkbox"][id*="turnstile"]');
                    if (checkbox) {
                      checkbox.click();
                      return { clicked: true, method: 'checkbox' };
                    }
                    const turnstileContainer = document.querySelector('[id*="turnstile"], [class*="turnstile"]');
                    if (turnstileContainer) {
                      turnstileContainer.click();
                      return { clicked: true, method: 'container' };
                    }
                    return { clicked: false };
                  })()
                `,
              });
              
              logger.info('Waiting 5s for Turnstile to process...');
              await sleep(5000);
              
              // Check if button is now enabled
              const recheckResult = await Runtime.evaluate({
                expression: `
                  (() => {
                    const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
                    return {
                      buttonFound: !!btn,
                      buttonEnabled: btn && !btn.hasAttribute('disabled')
                    };
                  })()
                `,
                returnByValue: true,
              });
              const recheckTs = recheckResult.result?.value as any;
              
              if (!recheckTs?.buttonEnabled) {
                logger.warn('Button still disabled after clicking checkbox');
              } else {
                logger.info('✓ Button enabled after clicking checkbox');
              }
            }
          }
        }
        
        if (!signInClicked) {
          logger.error('Could not click Sign In after reload — stopping OTP fetch');
          otp = null; // Don't try to fetch OTP if login failed
        } else {
          // Wait for OTP screen
          logger.info('Waiting for OTP screen...');
          await sleep(3000);
          
          // Disconnect for OTP Turnstile
          logger.info('Disconnecting CDP for OTP Turnstile...');
          await client.close();
          await sleep(8000);
          
          // Try fetching OTP again
          logger.info('Fetching OTP after full reload...');
          otp = await waitForOtp(2 * 60 * 1000);
        }
      }
      
      if (!otp) {
        logger.error('Could not get OTP after retry — manual entry required');
        await waitForEnter('\n>>> Enter OTP manually in browser, then press ENTER <<<\n');
      }
    }
    
    if (otp) {
      // ── Step 8: Reconnect CDP to fill OTP ────────────────────────────────
      logger.info('Reconnecting CDP to fill OTP...');
      client = await connectCDP('vfsglobal.com');
      ({ Runtime } = client);
      await client.Runtime.enable();

      // Fill OTP field using Angular native setter
      logger.info({ otp }, 'Filling OTP...');
      const fillResult = await Runtime.evaluate({
        expression: `
          (async () => {
            const inputs = document.querySelectorAll('input');
            const otpInput = Array.from(inputs).find(el =>
              el.placeholder?.includes('*') ||
              el.type === 'password' ||
              el.type === 'text'
            );
            if (!otpInput) return { ok: false, error: 'OTP input not found' };
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(otpInput, ${JSON.stringify(otp)});
            otpInput.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            return { ok: true, value: otpInput.value };
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });
      logger.info({ result: fillResult.result?.value }, '✓ OTP filled');

      // Wait 2 seconds for Angular to process the input
      logger.info('Waiting 2s for form to process OTP...');
      await sleep(2000);

      // ── Step 9: Check Submit button with disconnect/reconnect cycle ─────
      logger.info('Checking Submit button (disconnect/reconnect cycle, up to 4 minutes)...');
      let submitClicked = false;
      const maxChecks = 5; // Check at 2s, 62s, 122s, 182s, 242s
      const disconnectInterval = 60; // 60 seconds between checks
      
      for (let checkNum = 1; checkNum <= maxChecks; checkNum++) {
        // For first check, CDP is already connected (we just filled OTP)
        // For subsequent checks, reconnect CDP
        if (checkNum > 1) {
          logger.info(`Reconnecting CDP for check #${checkNum}...`);
          client = await connectCDP('vfsglobal.com');
          ({ Runtime } = client);
          await client.Runtime.enable();
        }
        
        const btnResult = await Runtime.evaluate({
          expression: `
            (() => {
              const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
              if (!btn) return { found: false };
              const disabled = btn.hasAttribute('disabled');
              if (!disabled) btn.click();
              return { found: true, disabled, clicked: !disabled };
            })()
          `,
          returnByValue: true,
        });
        const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
        
        if (btn?.clicked) {
          submitClicked = true;
          logger.info(`✓ Submit button enabled and clicked (check #${checkNum})`);
          break;
        }
        
        if (btn?.disabled) {
          const elapsedTime = 2 + (checkNum - 1) * disconnectInterval;
          logger.info(`[Check #${checkNum} at ${elapsedTime}s] Submit: disabled, waiting for Turnstile...`);
          
          // If not the last check, disconnect and wait
          if (checkNum < maxChecks) {
            logger.info(`Disconnecting CDP for ${disconnectInterval}s (giving Turnstile space to work)...`);
            await client.close();
            await sleep(disconnectInterval * 1000);
          }
        } else if (!btn?.found) {
          logger.warn(`[Check #${checkNum}] Submit button not found`);
          if (checkNum < maxChecks) {
            await client.close();
            await sleep(disconnectInterval * 1000);
          }
        }
      }

      if (!submitClicked) {
        logger.warn('Submit button still disabled after 5 checks (~242s) — Turnstile may have failed');
        logger.warn('Reloading page to retry (one time)...');
        
        // Ensure CDP is connected for reload
        if (!client || !client.Page) {
          client = await connectCDP('vfsglobal.com');
          ({ Page, Runtime } = client);
          await Page.enable();
          await Runtime.enable();
        }
        
        // Reload and retry the entire login flow
        await client.Page.enable();
        await client.Page.reload();
        await sleep(3000);
        
        // Wait for form
        logger.info('Waiting for login form after reload...');
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const check = await Runtime.evaluate({
            expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
            returnByValue: true,
          });
          if (check.result?.value === true) break;
        }
        
        // Re-fill credentials
        logger.info('Re-filling credentials...');
        await Runtime.evaluate({
          expression: `
            (async () => {
              const email = document.querySelector('#email');
              const pass  = document.querySelector('#password');
              if (!email || !pass) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(email, ${JSON.stringify(email)});
              email.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
              setter?.call(pass, ${JSON.stringify(password)});
              pass.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });
        
        // Disconnect for Turnstile
        logger.info('Disconnecting CDP for Turnstile (retry)...');
        await client.close();
        await sleep(7000);
        
        // Reconnect
        logger.info('Reconnecting CDP (retry)...');
        client = await connectCDP('vfsglobal.com');
        ({ Runtime } = client);
        await Runtime.enable();
        
        // Try clicking Sign In again
        logger.info('Waiting for Sign In button (retry, up to 4 minutes)...');
        let signInClickedRetry = false;
        const retryMaxWaitSeconds = 240;
        const retryCheckIntervalSeconds = 20;
        
        for (let elapsed = 0; elapsed <= retryMaxWaitSeconds; elapsed += retryCheckIntervalSeconds) {
          await sleep(retryCheckIntervalSeconds * 1000);
          
          const btnResult = await Runtime.evaluate({
            expression: `
              (() => {
                const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
                if (!btn) return { found: false };
                const disabled = btn.hasAttribute('disabled');
                if (!disabled) btn.click();
                return { found: true, disabled, clicked: !disabled };
              })()
            `,
            returnByValue: true,
          });
          const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
          
          if (btn?.clicked) {
            signInClickedRetry = true;
            logger.info('✓ Sign In clicked after reload');
            break;
          }
          
          if (btn?.disabled) {
            logger.info(`[${elapsed + retryCheckIntervalSeconds}s/${retryMaxWaitSeconds}s] Sign In (retry): disabled, waiting...`);
          }
        }
        
        if (!signInClickedRetry) {
          logger.error('Sign In still failed after reload — manual intervention required');
          process.exit(1);
        }
        
        // Wait for OTP screen
        logger.info('Waiting for OTP screen...');
        await sleep(3000);
        
        // Disconnect for OTP Turnstile
        logger.info('Disconnecting CDP for OTP Turnstile (retry)...');
        await client.close();
        await sleep(8000);
        
        // Reconnect to fill OTP (reuse already-fetched OTP)
        logger.info('Reconnecting CDP to fill OTP (retry)...');
        client = await connectCDP('vfsglobal.com');
        ({ Runtime } = client);
        await client.Runtime.enable();
        
        // Re-fill OTP
        logger.info({ otp }, 'Re-filling OTP after reload...');
        await Runtime.evaluate({
          expression: `
            (async () => {
              const inputs = document.querySelectorAll('input');
              const otpInput = Array.from(inputs).find(el =>
                el.placeholder?.includes('*') ||
                el.type === 'password' ||
                el.type === 'text'
              );
              if (!otpInput) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(otpInput, ${JSON.stringify(otp)});
              otpInput.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(r => setTimeout(r, 500));
              return true;
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });
        logger.info('✓ OTP re-filled');
        
        // Wait 2 seconds for form to process
        await sleep(2000);
        
        // Try Submit button again with disconnect/reconnect cycle
        logger.info('Checking Submit button (retry, disconnect/reconnect cycle)...');
        const retryMaxChecks = 5;
        const retryDisconnectInterval = 60;
        
        for (let checkNum = 1; checkNum <= retryMaxChecks; checkNum++) {
          // Reconnect CDP to check button status
          logger.info(`Reconnecting CDP for retry check #${checkNum}...`);
          client = await connectCDP('vfsglobal.com');
          ({ Runtime } = client);
          await Runtime.enable();
          
          const btnResult = await Runtime.evaluate({
            expression: `
              (() => {
                const btn = document.querySelector('button.btn-brand-orange, button[type="submit"]');
                if (!btn) return { found: false };
                const disabled = btn.hasAttribute('disabled');
                if (!disabled) btn.click();
                return { found: true, disabled, clicked: !disabled };
              })()
            `,
            returnByValue: true,
          });
          const btn = btnResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
          
          if (btn?.clicked) {
            submitClicked = true;
            logger.info(`✓ Submit clicked after reload (retry check #${checkNum})`);
            break;
          }
          
          if (btn?.disabled) {
            const elapsedTime = 2 + (checkNum - 1) * retryDisconnectInterval;
            logger.info(`[Retry check #${checkNum} at ${elapsedTime}s] Submit: disabled, waiting...`);
            
            if (checkNum < retryMaxChecks) {
              logger.info(`Disconnecting CDP for ${retryDisconnectInterval}s...`);
              await client.close();
              await sleep(retryDisconnectInterval * 1000);
            }
          }
        }
        
        if (!submitClicked) {
          logger.error('Submit still failed after reload — manual intervention required');
          process.exit(1);
        }
      }
    }
  }

  // ── Step 10: Wait for redirect to dashboard ─────────────────────────────
  logger.info('Waiting for login to complete...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const urlCheck = await Runtime.evaluate({ expression: 'location.pathname', returnByValue: true });
      const path = String(urlCheck.result?.value ?? '');
      if (!path.includes('/login')) {
        logger.info({ path }, '✓ Login complete — redirected away from login');
        break;
      }
    } catch (err) {
      // CDP might be disconnected, try to reconnect
      if (i % 5 === 0) {
        try {
          client = await connectCDP('vfsglobal.com');
          ({ Runtime } = client);
          await client.Runtime.enable();
        } catch { /* retry */ }
      }
    }
  }

  // ── Step 11: Dismiss Chrome password save dialog ────────────────────────
  logger.info('Checking for Chrome password save dialog...');
  await sleep(2000); // Wait for dialog to appear
  
  // Try to dismiss the password save dialog (Chrome native dialog)
  // This is a browser-level dialog, not a DOM element, so we'll use keyboard
  await Runtime.evaluate({
    expression: `
      (() => {
        // Press Escape key to dismiss any overlays
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        return true;
      })()
    `,
    returnByValue: true,
  });
  
  logger.info('✓ Attempted to dismiss password dialog (Escape key)');
  await sleep(1000);

  // ── Step 12: Click "Start New Booking" button ───────────────────────────
  logger.info('Looking for "Start New Booking" button...');
  let bookingClicked = false;
  
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const result = await Runtime.evaluate({
      expression: `
        (() => {
          // Primary: Look for "Start New Booking" text
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const bookingBtn = buttons.find(btn => {
            const text = btn.textContent?.toLowerCase() || '';
            return text.includes('start new booking');
          });
          
          if (bookingBtn) {
            bookingBtn.click();
            return { found: true, text: bookingBtn.textContent?.trim(), method: 'text' };
          }
          
          // Fallback: Look for orange button with "booking" text
          const orangeBtn = document.querySelector('button[class*="orange"], a[class*="orange"]');
          if (orangeBtn && orangeBtn.textContent?.toLowerCase().includes('booking')) {
            orangeBtn.click();
            return { found: true, text: orangeBtn.textContent?.trim(), method: 'orange-fallback' };
          }
          
          return { found: false };
        })()
      `,
      returnByValue: true,
    });
    
    const btn = result.result?.value as { found: boolean; text?: string; method?: string } | null;
    if (btn?.found) {
      logger.info({ buttonText: btn.text, method: btn.method }, '✓ "Start New Booking" button clicked');
      bookingClicked = true;
      break;
    }
    
    if (i % 5 === 0) {
      logger.info(`[${i + 1}/20] Waiting for "Start New Booking" button...`);
    }
  }

  if (!bookingClicked) {
    logger.warn('Could not find "Start New Booking" button automatically');
    logger.warn('Please click it manually');
  } else {
    // Wait for booking page to load
    logger.info('Waiting for booking page to load...');
    await sleep(3000);
    
    // Verify we're on the booking page
    const urlCheck = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    logger.info({ url: urlCheck.result?.value }, '✓ Navigated to booking page');
  }

  // ── Step 14: Automate booking page setup ────────────────────────────────
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Automating booking page setup...');
  logger.info('════════════════════════════════════════════════════');

  // Wait for booking page to fully load
  await sleep(2000);
  
  // Enable Network monitoring BEFORE selecting sub-category to capture first API call
  const { Network, Runtime: Runtime3 } = client;
  await Network.enable();
  await Runtime3.enable();
  
  let pollCount = 0;
  let lastEarliestDate: string | null = null;
  const pending = new Map<string, number>();

  // Set up Network listeners to capture ALL API calls (including the first one)
  Network.requestWillBeSent((p: any) => {
    if (!p.request?.url?.includes('CheckIsSlotAvailable')) return;
    pending.set(p.requestId, 0);
  });
  Network.responseReceived((p: any) => {
    if (!pending.has(p.requestId)) return;
    pending.set(p.requestId, p.response?.status ?? 0);
  });
  Network.loadingFinished(async (p: any) => {
    if (!pending.has(p.requestId)) return;
    const status = pending.get(p.requestId)!;
    pending.delete(p.requestId);

    try {
      const resp = await Network.getResponseBody({ requestId: p.requestId });
      const data = JSON.parse(resp.body);
      pollCount++;
      
      // Response structure: { earliestDate: "05/30/2026 00:00:00", earliestSlotLists: [...] }
      const earliestDate = data?.earliestDate ?? 'N/A';
      const slots = data?.earliestSlotLists?.length ?? 0;
      
      const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
      logger.info(`[${now}] Poll #${pollCount} — earliestDate: ${earliestDate} | status: ${status} | slots: ${slots}`);

      if (earliestDate !== lastEarliestDate && lastEarliestDate !== null && earliestDate !== 'N/A') {
        logger.warn({ old: lastEarliestDate, new: earliestDate }, '⚠️  SLOT CHANGE DETECTED');
      }
      lastEarliestDate = earliestDate;
    } catch (err: any) {
      logger.warn({ err, request: p }, 'Failed to read response body');
    }
  });

  // Step 14a: Select Application Centre (Mangalore)
  logger.info('Selecting Application Centre: Mangalore...');
  const centreResult = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          // Find the Application Centre dropdown (first mat-select)
          const selects = document.querySelectorAll('mat-select');
          if (selects.length < 1) return { ok: false, error: 'Centre dropdown not found' };
          
          const centreSelect = selects[0];
          centreSelect.click();
          await new Promise(r => setTimeout(r, 1000));
          
          // Find Mangalore option
          const options = document.querySelectorAll('mat-option');
          const mangaloreOption = Array.from(options).find(opt => 
            opt.textContent?.includes('Mangalore')
          );
          
          if (!mangaloreOption) return { ok: false, error: 'Mangalore option not found' };
          
          mangaloreOption.click();
          await new Promise(r => setTimeout(r, 1000));
          return { ok: true, selected: mangaloreOption.textContent?.trim() };
        } catch(e) {
          return { ok: false, error: String(e) };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15_000,
  });
  
  const centreRes = centreResult.result?.value as { ok: boolean; selected?: string; error?: string };
  if (centreRes?.ok) {
    logger.info({ centre: centreRes.selected }, '✓ Application Centre selected');
  } else {
    logger.warn({ error: centreRes?.error }, 'Failed to select centre — may already be selected');
  }

  // Step 14b: Wait for Appointment Category to auto-populate
  logger.info('Waiting for Appointment Category to auto-populate...');
  await sleep(3000);
  
  const categoryCheck = await Runtime.evaluate({
    expression: `
      (() => {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 2) return { found: false };
        const categoryText = selects[1].textContent?.trim();
        return { found: true, category: categoryText };
      })()
    `,
    returnByValue: true,
  });
  const catRes = categoryCheck.result?.value as { found: boolean; category?: string };
  logger.info({ category: catRes?.category }, '✓ Appointment Category auto-populated');

  // Step 14c: Select first sub-category to trigger initial slot check
  logger.info('Selecting first sub-category to load slots...');
  
  // Wait for sub-category options to load
  await sleep(2000);
  
  const firstSubCatResult = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const selects = document.querySelectorAll('mat-select');
          if (selects.length < 3) return { ok: false, error: 'Sub-category dropdown not found' };
          
          // Click to open dropdown
          selects[2].click();
          await new Promise(r => setTimeout(r, 1500)); // Wait longer for options to load
          
          const options = document.querySelectorAll('mat-option');
          const firstOption = Array.from(options).find(o => 
            o.textContent?.trim().includes('Long Stay')
          );
          
          if (!firstOption) {
            // Log available options for debugging
            const availableOptions = Array.from(options).map(o => o.textContent?.trim());
            return { ok: false, error: 'Long Stay option not found', availableOptions };
          }
          
          firstOption.click();
          await new Promise(r => setTimeout(r, 500));
          return { ok: true, selected: firstOption.textContent?.trim() };
        } catch(e) {
          return { ok: false, error: String(e) };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10_000,
  });
  
  const firstSubRes = firstSubCatResult.result?.value as { ok: boolean; selected?: string; error?: string; availableOptions?: string[] };
  if (firstSubRes?.ok) {
    logger.info({ subCategory: firstSubRes.selected }, '✓ First sub-category selected');
  } else {
    logger.warn({ error: firstSubRes?.error, availableOptions: firstSubRes?.availableOptions }, 'Could not select first sub-category — will start polling anyway');
  }

  // Wait for slot data to load
  logger.info('Waiting for slot data to load...');
  await sleep(3000);

  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  ✓ Booking page setup complete!');
  logger.info('  Starting automated polling...');
  logger.info('════════════════════════════════════════════════════');

  // ── Step 15: Start polling loop ──────────────────────────────────────────
  const urlCheck = await Runtime3.evaluate({ expression: 'location.href', returnByValue: true });
  logger.info({ url: urlCheck.result?.value }, '✓ Polling started on page');

  let subCatIndex = 0;

  // Wait for first natural response (from initial sub-category selection)
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (pollCount > 0) { clearInterval(check); resolve(); } }, 500);
    setTimeout(() => { clearInterval(check); resolve(); }, 30_000);
  });

  if (pollCount === 0) {
    subCatIndex = 1;
    await selectSubCategory(Runtime3, SUB_CATEGORIES[subCatIndex]);
  }

  logger.info('✓ Polling active — press Ctrl+C to stop');

  process.on('SIGINT', async () => {
    logger.info('\nStopping...');
    await client.close().catch(() => {});
    chromeProc.kill();
    process.exit(0);
  });

  while (true) {
    await sleep(POLL_INTERVAL_MS);
    subCatIndex = (subCatIndex + 1) % SUB_CATEGORIES.length;
    logger.info(`[${ts()}] Triggering poll — "${SUB_CATEGORIES[subCatIndex]}"`);
    await selectSubCategory(Runtime3, SUB_CATEGORIES[subCatIndex]);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
