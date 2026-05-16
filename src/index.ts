/**
 * Campus Slot Notifier — Production (Fully Automated)
 *
 * Proven architecture with complete automation:
 *   1. Launch Chrome with --remote-debugging-port
 *   2. CDP connects → navigates to login → auto-fills email + password
 *   3. CDP disconnects → Login Turnstile passes ✓
 *   4. CDP reconnects → auto-clicks Sign In button
 *   5. CDP disconnects → OTP Turnstile passes ✓
 *   6. Fetches OTP from Gmail API automatically
 *   7. CDP reconnects → auto-fills OTP
 *   8. CDP disconnects → Submit Turnstile passes ✓
 *   9. CDP reconnects → auto-clicks Submit button
 *   10. Redirects to dashboard → manual navigation to booking page
 *   11. Polling runs via sub-category cycling every 30s
 *   12. Slot changes logged (Telegram notifications in Phase 6)
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

  // Dismiss cookie banner immediately
  logger.info('Dismissing cookie banner...');
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

  // ── Step 4: Reconnect CDP + wait for Sign In button + click ─────────────
  logger.info('Reconnecting CDP...');
  client = await connectCDP('vfsglobal.com');
  ({ Runtime } = client);
  await client.Runtime.enable();

  logger.info('Waiting for Sign In button to become enabled...');
  let clicked = false;
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
    logger.info(`[${i + 1}/30] Sign In: ${btn?.found ? (btn.disabled ? 'disabled' : '✓ clicked') : 'not found'}`);
    if (btn?.clicked) { clicked = true; logger.info('✓ Sign In button clicked'); break; }
    
    // After 7 attempts (7 seconds), check if Turnstile is the issue
    if (i === 6 && btn?.disabled) {
      logger.warn('Sign In button still disabled after 7s — checking Login Turnstile...');
      const loginTurnstileCheck = await Runtime.evaluate({
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
      const loginTs = loginTurnstileCheck.result?.value as any;
      logger.info({ loginTurnstileStatus: loginTs }, 'Login Turnstile check result');
      
      // If Turnstile is visible but not checked, try to click the checkbox
      if (loginTs?.turnstileVisible && !loginTs?.checkboxChecked) {
        logger.warn('Login Turnstile not checked — attempting to click checkbox...');
        
        // Try to click the Turnstile checkbox
        const clickResult = await Runtime.evaluate({
          expression: `
            (() => {
              // Try to find and click the Turnstile checkbox
              const checkbox = document.querySelector('input[type="checkbox"][name*="cf-turnstile"], input[type="checkbox"][id*="turnstile"]');
              if (checkbox) {
                checkbox.click();
                return { clicked: true, method: 'checkbox' };
              }
              
              // Fallback: try to click the Turnstile iframe or container
              const turnstileContainer = document.querySelector('[id*="turnstile"], [class*="turnstile"]');
              if (turnstileContainer) {
                turnstileContainer.click();
                return { clicked: true, method: 'container' };
              }
              
              return { clicked: false };
            })()
          `,
          returnByValue: true,
        });
        const clickRes = clickResult.result?.value as any;
        logger.info({ clickResult: clickRes }, 'Checkbox click attempt');
        
        // Wait for Turnstile to process the click
        logger.info('Waiting 5s for Turnstile to process...');
        await sleep(5000);
        
        // Check if Sign In button is now enabled (the real indicator of Turnstile success)
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
        logger.info({ recheckStatus: recheckTs }, 'Sign In button recheck after click');
        
        // If button still disabled after clicking, reload
        if (!recheckTs?.buttonEnabled) {
          logger.warn('Sign In button still disabled after clicking — reloading page...');
          await client.close();
          await sleep(2000);
          
          // Reconnect and reload
          logger.info('Reconnecting CDP to reload page...');
          client = await connectCDP('vfsglobal.com');
          ({ Page, Runtime } = client);
          await Page.enable();
          await Runtime.enable();
          
          logger.info('Reloading login page...');
          await Page.navigate({ url: VFS_LOGIN_URL });
          await sleep(3000);
          
          // Re-fill credentials
          logger.info('Re-filling credentials after reload...');
          const refillResult = await Runtime.evaluate({
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
                return { ok: true };
              })()
            `,
            awaitPromise: true, returnByValue: true, timeout: 10_000,
          });
          logger.info({ result: refillResult.result?.value }, 'Re-fill result');
          
          // Disconnect for login Turnstile
          logger.info('Disconnecting CDP for login Turnstile (retry)...');
          await client.close();
          await sleep(7000);
          
          // Reconnect
          logger.info('Reconnecting CDP after retry...');
          client = await connectCDP('vfsglobal.com');
          ({ Runtime } = client);
          await client.Runtime.enable();
          
          // Reset loop to try Sign In button again
          i = -1; // Will become 0 on next iteration
          continue;
        } else {
          logger.info('✓ Sign In button enabled — Turnstile passed successfully');
          // Continue with the loop, button should be enabled now
        }
      }
    }
  }

  if (!clicked) {
    logger.warn('Could not click Sign In — Turnstile may have failed');
    logger.warn('Please click Sign In manually');
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

    const otp = await waitForOtp(2 * 60 * 1000);

    if (!otp) {
      logger.error('Could not get OTP from Gmail — please enter it manually');
      await waitForEnter('\n>>> Enter OTP manually in browser, then press ENTER <<<\n');
    } else {
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

      // ── Step 9: Disconnect CDP again before submit button Turnstile ─────
      logger.info('Disconnecting CDP before submit button Turnstile...');
      await client.close();
      logger.info('✓ CDP disconnected — submit Turnstile should pass now');
      await sleep(8000); // Give Turnstile more time to render and complete (increased from 5s)

      // ── Step 10: Reconnect CDP and click submit ─────────────────────────
      logger.info('Reconnecting CDP to click submit...');
      client = await connectCDP('vfsglobal.com');
      ({ Runtime } = client);
      await client.Runtime.enable();

      logger.info('Clicking Sign In button...');
      let submitClicked = false;
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
        logger.info(`[${i + 1}/30] Submit button: ${btn?.found ? (btn.disabled ? 'disabled' : '✓ clicked') : 'not found'}`);
        if (btn?.clicked) {
          submitClicked = true;
          logger.info('✓ Submit button clicked');
          break;
        }
        
        // After 7 attempts (7 seconds), check if Turnstile is the issue
        if (i === 6 && btn?.disabled) {
          logger.warn('Submit button still disabled after 7s — checking OTP Turnstile...');
          const otpTurnstileCheck = await Runtime.evaluate({
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
          const otpTs = otpTurnstileCheck.result?.value as any;
          logger.info({ otpTurnstileStatus: otpTs }, 'OTP Turnstile check result');
          
          // If Turnstile is visible but not checked, try to click the checkbox
          if (otpTs?.turnstileVisible && !otpTs?.checkboxChecked) {
            logger.warn('OTP Turnstile not checked — attempting to click checkbox...');
            
            // Try to click the Turnstile checkbox
            const clickResult = await Runtime.evaluate({
              expression: `
                (() => {
                  // Try to find and click the Turnstile checkbox
                  const checkbox = document.querySelector('input[type="checkbox"][name*="cf-turnstile"], input[type="checkbox"][id*="turnstile"]');
                  if (checkbox) {
                    checkbox.click();
                    return { clicked: true, method: 'checkbox' };
                  }
                  
                  // Fallback: try to click the Turnstile iframe or container
                  const turnstileContainer = document.querySelector('[id*="turnstile"], [class*="turnstile"]');
                  if (turnstileContainer) {
                    turnstileContainer.click();
                    return { clicked: true, method: 'container' };
                  }
                  
                  return { clicked: false };
                })()
              `,
              returnByValue: true,
            });
            const clickRes = clickResult.result?.value as any;
            logger.info({ clickResult: clickRes }, 'Checkbox click attempt');
            
            // Wait for Turnstile to process the click
            logger.info('Waiting 5s for Turnstile to process...');
            await sleep(5000);
            
            // Check if Submit button is now enabled (the real indicator of Turnstile success)
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
            logger.info({ recheckStatus: recheckTs }, 'Submit button recheck after click');
            
            // If button still disabled after clicking, reload
            if (!recheckTs?.buttonEnabled) {
              logger.warn('Submit button still disabled after clicking — reloading page...');
              await client.close();
              await sleep(2000);
              
              // Reconnect and reload
              logger.info('Reconnecting CDP to reload page...');
              client = await connectCDP('vfsglobal.com');
              ({ Page, Runtime } = client);
              await Page.enable();
              await Runtime.enable();
              
              logger.info('Reloading login page...');
              await Page.navigate({ url: VFS_LOGIN_URL });
              await sleep(3000);
              
              // Re-fill credentials
              logger.info('Re-filling credentials after reload...');
              const refillResult = await Runtime.evaluate({
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
                    return { ok: true };
                  })()
                `,
                awaitPromise: true, returnByValue: true, timeout: 10_000,
              });
              logger.info({ result: refillResult.result?.value }, 'Re-fill result');
              
              // Disconnect for login Turnstile
              logger.info('Disconnecting CDP for login Turnstile (retry)...');
              await client.close();
              await sleep(8000);
              
              // Reconnect and click Sign In
              logger.info('Reconnecting CDP...');
              client = await connectCDP('vfsglobal.com');
              ({ Runtime } = client);
              await client.Runtime.enable();
              
              // Click Sign In
              for (let j = 0; j < 10; j++) {
                await sleep(1000);
                const signInResult = await Runtime.evaluate({
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
                const signInBtn = signInResult.result?.value as { found: boolean; disabled: boolean; clicked: boolean } | null;
                if (signInBtn?.clicked) {
                  logger.info('✓ Sign In clicked after reload');
                  break;
                }
              }
              
              // Wait for OTP screen again
              await sleep(3000);
              
              // Disconnect for OTP Turnstile
              logger.info('Disconnecting CDP for OTP Turnstile (retry)...');
              await client.close();
              await sleep(8000);
              
              // Note: OTP already fetched, reuse it
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
              
              // Disconnect for submit Turnstile
              logger.info('Disconnecting CDP for submit Turnstile (retry)...');
              await client.close();
              await sleep(8000);
              
              // Reconnect and try submit again
              logger.info('Reconnecting CDP to click submit (retry)...');
              client = await connectCDP('vfsglobal.com');
              ({ Runtime } = client);
              await client.Runtime.enable();
              
              // Reset loop to try submit button again
              i = -1; // Will become 0 on next iteration
              continue;
            } else {
              logger.info('✓ Submit button enabled — Turnstile passed successfully');
              // Continue with the loop, button should be enabled now
            }
          }
        }
      }

      if (!submitClicked) {
        logger.warn('Could not click submit — Turnstile may have failed');
        logger.warn('Please click submit manually');
      }
    }
  }

  // ── Step 11: Wait for redirect to dashboard ─────────────────────────────
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

  // ── Step 12: Dismiss Chrome password save dialog ────────────────────────
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

  // ── Step 13: Click "Start New Booking" button ───────────────────────────
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
  const firstSubCatResult = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const selects = document.querySelectorAll('mat-select');
          if (selects.length < 3) return { ok: false, error: 'Sub-category dropdown not found' };
          
          selects[2].click();
          await new Promise(r => setTimeout(r, 800));
          
          const options = document.querySelectorAll('mat-option');
          const firstOption = Array.from(options).find(o => 
            o.textContent?.trim().includes('Long Stay')
          );
          
          if (!firstOption) return { ok: false, error: 'Long Stay option not found' };
          
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
  
  const firstSubRes = firstSubCatResult.result?.value as { ok: boolean; selected?: string; error?: string };
  if (firstSubRes?.ok) {
    logger.info({ subCategory: firstSubRes.selected }, '✓ First sub-category selected');
  } else {
    logger.error({ error: firstSubRes?.error }, 'Failed to select first sub-category');
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
  const { Network, Runtime: Runtime3 } = client;
  await Network.enable();
  await Runtime3.enable();

  const urlCheck = await Runtime3.evaluate({ expression: 'location.href', returnByValue: true });
  logger.info({ url: urlCheck.result?.value }, '✓ Polling started on page');

  let pollCount = 0;
  let lastEarliestDate: string | null = null;
  let subCatIndex = 0;
  const pending = new Map<string, number>();

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
      const r = await Network.getResponseBody({ requestId: p.requestId });
      const parsed = JSON.parse(r.body ?? '{}');
      pollCount++;
      const earliestDate: string | null = parsed.earliestDate ?? null;
      const slots = parsed.earliestSlotLists ?? [];
      const changed = earliestDate !== lastEarliestDate && lastEarliestDate !== null;
      if (changed) {
        logger.info('════════════════════════════════════════════════════');
        logger.info(`[${ts()}] ⚡ SLOT CHANGED: ${lastEarliestDate} → ${earliestDate}`);
        slots.forEach((s: any, i: number) => logger.info(`  Slot ${i + 1}: ${s.date} — applicants: ${s.applicant}`));
        logger.info('════════════════════════════════════════════════════');
        // TODO Phase 6: Telegram notification here
      } else {
        logger.info(`[${ts()}] Poll #${pollCount} — earliestDate: ${earliestDate ?? 'none'} | status: ${status} | slots: ${slots.length}`);
      }
      lastEarliestDate = earliestDate;
    } catch (err) { logger.warn({ err }, 'Failed to read response body'); }
  });

  // Wait for first natural response
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
