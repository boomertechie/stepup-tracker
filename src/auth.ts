import { chromium, type BrowserContext, type Page } from "playwright-core";
import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import type { TrackerConfig } from "./types";

const PORTAL_HOST = "apply.stepupforstudents.org";
const PROFILE_DIR = resolve(
  process.env.STEPUP_PROFILE_DIR ||
  resolve(homedir(), ".stepup-tracker/browser-profile")
);
const CHROME_ARGS = process.platform === "linux"
  ? ["--no-sandbox", "--disable-gpu"]
  : ["--disable-gpu"];

/** Function that provides a prompt response (stdin or web UI) */
export type PromptFn = (message: string, hidden?: boolean) => Promise<string>;

// Default: read from stdin
const stdinPrompt: PromptFn = (message, hidden = false) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (hidden) {
      process.stderr.write(message);
      rl.question("", (answer) => { rl.close(); resolve(answer.trim()); });
    } else {
      rl.question(message, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });

/**
 * Launch a persistent browser and ensure we're logged into the portal.
 * Accepts an optional promptFn for providing credentials/MFA codes from
 * sources other than stdin (e.g., web UI).
 */
export async function launchAndLogin(
  config: TrackerConfig,
  promptFn: PromptFn = stdinPrompt,
  onStatus?: (status: string) => void,
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const log = (msg: string) => { console.error(msg); onStatus?.(msg); };

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: config.headless,
    executablePath: config.browser_path,
    args: CHROME_ARGS,
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  });
  const page = context.pages()[0] || (await context.newPage());

  log("Navigating to EMA portal...");
  await page.goto(config.portal_url, { waitUntil: "networkidle", timeout: 30000 });

  const dashboardReady = page.locator("h1:has-text('Scholarship Portal')");

  try {
    await dashboardReady.waitFor({ timeout: 15000 });
    log("Already authenticated.");
    return { context, page };
  } catch {
    // Need to authenticate
  }

  log("Authentication required...");

  const landedOn = await Promise.race([
    page.waitForSelector("#logonIdentifier", { timeout: 20000 }).then(() => "login" as const),
    page.waitForSelector("#sendCode", { timeout: 20000 }).then(() => "mfa" as const),
    dashboardReady.waitFor({ timeout: 20000 }).then(() => "dashboard" as const),
  ]).catch(() => "timeout" as const);

  if (landedOn === "dashboard") {
    log("SSO auto-redirect completed.");
    return { context, page };
  }

  if (landedOn === "login") {
    await doLogin(page, promptFn, log);
  } else if (landedOn === "mfa") {
    log("MFA required (SSO skipped credentials)...");
    const mfaOk = await handle2FA(page, promptFn, log);
    if (!mfaOk) {
      log("MFA failed.");
      await context.close();
      throw new Error("MFA verification failed");
    }
  } else {
    await context.close();
    throw new Error("Authentication timed out");
  }

  try {
    await dashboardReady.waitFor({ timeout: 30000 });
  } catch {
    await context.close();
    throw new Error("Dashboard didn't load after login");
  }

  log("Authenticated.");
  return { context, page };
}

/**
 * Login-only mode: authenticate and verify, then close.
 */
export async function loginOnly(config: TrackerConfig): Promise<void> {
  const { context } = await launchAndLogin(config);
  console.log("Login successful. Session saved.");
  await context.close();
}

// ─── Login flow ──────────────────────────────────────────────────────

async function doLogin(page: Page, promptFn: PromptFn, log: (s: string) => void): Promise<void> {
  let username = process.env.STEPUP_USERNAME || "";
  let password = process.env.STEPUP_PASSWORD || "";

  if (!username) username = await promptFn("EMA Username: ");
  if (!password) password = await promptFn("EMA Password: ", true);

  if (!username || !password) throw new Error("Username and password are required");

  await page.fill("#logonIdentifier", username);
  await page.fill("#password", password);
  const rememberMe = page.locator("#rememberMe");
  if (await rememberMe.isVisible().catch(() => false)) {
    await rememberMe.check();
  }

  log("Submitting credentials...");
  await page.click("#next");
  await page.waitForTimeout(3000);

  if (isPortalDashboard(page.url())) return;

  const handled = await handle2FA(page, promptFn, log);
  if (!handled) {
    const errorEl = await page.locator(".error, .itemLevel").first();
    const errorText = await errorEl.textContent().catch(() => null);
    throw new Error(errorText?.trim() || "Authentication failed");
  }
}

// ─── 2FA handling ────────────────────────────────────────────────────

async function handle2FA(page: Page, promptFn: PromptFn, log: (s: string) => void): Promise<boolean> {
  const textMeRadio = page.locator("#textMe");
  if (await textMeRadio.isVisible().catch(() => false)) {
    log("Selecting 'Text me' for MFA...");
    await textMeRadio.check();
    await page.waitForTimeout(500);
  }

  const sendCodeBtn = page.locator("#sendCode");
  if (await sendCodeBtn.isVisible().catch(() => false)) {
    log("Sending verification code...");
    await sendCodeBtn.click();
    await page.waitForTimeout(3000);
  }

  const codeSelectors = [
    "#verificationCode", "#readOnlyEmail_ver_input", "#otpCode",
    "input[name='verificationCode']", "input[placeholder*='code']",
    "input[placeholder*='Code']",
  ];

  let codeInput = null;
  for (const sel of codeSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) { codeInput = el; break; }
  }

  if (!codeInput) {
    const allInputs = await page.locator("input[type=text], input[type=number], input[type=tel], input:not([type])").all();
    for (const input of allInputs) {
      const visible = await input.isVisible().catch(() => false);
      const id = await input.getAttribute("id").catch(() => "");
      if (visible && id !== "logonIdentifier" && id !== "textMe" && id !== "callMe") {
        codeInput = input;
        break;
      }
    }
  }

  if (!codeInput) return false;

  log("Waiting for verification code...");
  const code = await promptFn("Verification code: ");
  if (!code) return false;

  await codeInput.fill(code);

  const verifySelectors = [
    "button:has-text('Verify')", "#readOnlyEmail_ver_but_verify",
    "#email_ver_but_verify", "button:has-text('Continue')",
    "button:has-text('Submit')", "button[type=submit]",
  ];
  for (const sel of verifySelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      log("Verifying code...");
      await btn.click();
      break;
    }
  }

  try {
    await page.waitForURL(`https://${PORTAL_HOST}/**`, { timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle");
    return isPortalDashboard(page.url());
  } catch {
    const contBtn = page.locator("button:has-text('Continue'), #continue, #next").first();
    if (await contBtn.isVisible().catch(() => false)) {
      await contBtn.click();
      try {
        await page.waitForURL(`https://${PORTAL_HOST}/**`, { timeout: 15000 });
        await page.waitForTimeout(2000);
        return isPortalDashboard(page.url());
      } catch { /* fall through */ }
    }
    return false;
  }
}

// ─── URL checks ──────────────────────────────────────────────────────

function isPortalDashboard(url: string): boolean {
  return url.includes(PORTAL_HOST) && !url.includes("/authentication/") && !url.includes("login.stepupforstudents.org");
}

export function isLoginPage(url: string): boolean {
  return url.includes("login.stepupforstudents.org") || url.includes("/authentication/login");
}
