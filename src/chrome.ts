import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const HOME = homedir();
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

export function findChrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates: string[] = [];

  if (IS_MAC) {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (IS_WIN) {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || resolve(HOME, "AppData/Local");
    candidates.push(
      resolve(pf, "Google/Chrome/Application/chrome.exe"),
      resolve(pf86, "Google/Chrome/Application/chrome.exe"),
      resolve(localAppData, "Google/Chrome/Application/chrome.exe"),
      resolve(pf, "Chromium/Application/chrome.exe"),
      resolve(localAppData, "Chromium/Application/chrome.exe"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    );
  }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Search puppeteer cache
  const cacheDirs = IS_MAC
    ? [resolve(HOME, "Library/Caches/puppeteer/chrome")]
    : IS_WIN
      ? [resolve(HOME, ".cache/puppeteer/chrome"), resolve(process.env.LOCALAPPDATA || "", "puppeteer/chrome")]
      : [resolve(HOME, ".cache/puppeteer/chrome")];

  const binNames = IS_WIN
    ? ["chrome.exe"]
    : IS_MAC
      ? ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome"]
      : ["chrome-linux64/chrome", "chrome"];

  for (const base of cacheDirs) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).sort().reverse();
    for (const d of dirs) {
      for (const bin of binNames) {
        const chrome = resolve(base, d, bin);
        if (existsSync(chrome)) return chrome;
      }
    }
  }

  throw new Error(
    "No Chrome/Chromium found. Install Chrome or set CHROME_PATH env var.\n" +
    (IS_MAC ? "  brew install --cask google-chrome" :
     IS_WIN ? "  Download from https://www.google.com/chrome/" :
              "  sudo apt install chromium-browser")
  );
}
