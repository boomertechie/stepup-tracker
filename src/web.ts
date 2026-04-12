import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { extract } from "./extractor";
import { loadTransactions, saveTransactions, mergeTransactions, loadBalances, saveBalances, addBalanceSnapshot } from "./storage";
import type { TrackerConfig, TransactionStore, BalanceStore, Transaction, LineItem } from "./types";

function findChromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  for (const p of candidates) { if (existsSync(p)) return p; }
  // Search puppeteer cache
  const puppeteerBase = resolve(process.env.HOME || "", ".cache/puppeteer/chrome");
  if (existsSync(puppeteerBase)) {
    const dirs = readdirSync(puppeteerBase).sort().reverse();
    for (const d of dirs) {
      const chrome = resolve(puppeteerBase, d, "chrome-linux64/chrome");
      if (existsSync(chrome)) return chrome;
    }
  }
  return "chromium";
}

function loadJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ─── Extract job state ───────────────────────────────────────────────

type JobState =
  | { phase: "idle" }
  | { phase: "running"; status: string; startedAt: number }
  | { phase: "waiting_mfa"; status: string; startedAt: number; resolveMfa: (code: string) => void }
  | { phase: "complete"; status: string; finishedAt: number; result: string }
  | { phase: "error"; status: string; finishedAt: number; error: string };

let job: JobState = { phase: "idle" };
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minute cooldown

export function startServer(txPath: string, balPath: string, port: number): void {
  const PAI_DIR = process.env.PAI_DIR || resolve(process.env.HOME || "", ".claude");
  const DATA_DIR = resolve(PAI_DIR, "context/family/step-up-scholarship/data");
  const config: TrackerConfig = loadJSON(resolve(DATA_DIR, "config.json"), {
    portal_url: "https://apply.stepupforstudents.org",
    auth_state_path: resolve(PAI_DIR, "playwright-data/stepup-auth.json"),
    browser_path: findChromePath(),
    data_dir: DATA_DIR,
    headless: true,
  });

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/data") {
        const txStore = loadJSON<TransactionStore>(txPath, { version: 1, last_extract: null, transactions: [] });
        const balStore = loadJSON<BalanceStore>(balPath, { version: 1, snapshots: [] });
        return Response.json({ txStore, balStore });
      }

      if (url.pathname === "/api/extract/start" && req.method === "POST") {
        return handleExtractStart(config, txPath, balPath);
      }

      if (url.pathname === "/api/extract/mfa" && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { code?: string };
        return handleMfaSubmit(body.code || "");
      }

      if (url.pathname === "/api/extract/status") {
        return Response.json({
          phase: job.phase,
          status: "status" in job ? job.status : "",
          ...(job.phase === "complete" ? { result: job.result } : {}),
          ...(job.phase === "error" ? { error: job.error } : {}),
        });
      }

      return new Response(renderPage(txPath, balPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  console.log(`Step Up Tracker running at http://localhost:${port}`);
  console.log(`Also available at http://10.27.27.70:${port} on the network`);
}

function handleExtractStart(config: TrackerConfig, txPath: string, balPath: string): Response {
  // Check cooldown
  if (job.phase === "complete" && Date.now() - job.finishedAt < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - job.finishedAt)) / 1000);
    return Response.json({ error: `Cooldown active. Try again in ${remaining}s.` }, { status: 429 });
  }

  if (job.phase === "running" || job.phase === "waiting_mfa") {
    return Response.json({ error: "Extract already in progress." }, { status: 409 });
  }

  // Check credentials
  if (!process.env.STEPUP_USERNAME || !process.env.STEPUP_PASSWORD) {
    return Response.json({ error: "STEPUP_USERNAME and STEPUP_PASSWORD env vars required." }, { status: 400 });
  }

  job = { phase: "running", status: "Starting...", startedAt: Date.now() };

  // Web-based prompt: resolves when MFA code is submitted via API
  const webPrompt = (message: string): Promise<string> => {
    if (message.includes("Verification code") || message.includes("code")) {
      return new Promise((resolve) => {
        job = { phase: "waiting_mfa", status: "Enter verification code", startedAt: (job as any).startedAt, resolveMfa: resolve };
      });
    }
    // For username/password, return from env (already handled by auth.ts)
    return Promise.resolve("");
  };

  const onStatus = (status: string) => {
    if (job.phase === "running" || job.phase === "waiting_mfa") {
      (job as any).status = status;
    }
  };

  // Run extract in background
  runExtract(config, txPath, balPath, webPrompt, onStatus);

  return Response.json({ ok: true, phase: "running" });
}

function handleMfaSubmit(code: string): Response {
  if (job.phase !== "waiting_mfa") {
    return Response.json({ error: "Not waiting for MFA code." }, { status: 400 });
  }
  if (!code) {
    return Response.json({ error: "Code is required." }, { status: 400 });
  }

  job.resolveMfa(code);
  job = { phase: "running", status: "Verifying code...", startedAt: (job as any).startedAt };
  return Response.json({ ok: true });
}

async function runExtract(
  config: TrackerConfig,
  txPath: string,
  balPath: string,
  promptFn: (msg: string) => Promise<string>,
  onStatus: (s: string) => void,
): Promise<void> {
  try {
    const txStore = loadTransactions(txPath);
    const result = await extract(config, promptFn, onStatus, txStore.transactions);
    const { merged, added, updated } = mergeTransactions(txStore.transactions, result.transactions);
    saveTransactions(txPath, { version: 1, last_extract: new Date().toISOString(), transactions: merged });

    if (result.balance) {
      const balStore = loadBalances(balPath);
      const updatedBal = addBalanceSnapshot(balStore, result.balance);
      saveBalances(balPath, updatedBal);
    }

    job = {
      phase: "complete",
      status: "Done",
      finishedAt: Date.now(),
      result: `${added} new, ${updated} updated, ${merged.length} total`,
    };
  } catch (e: any) {
    job = {
      phase: "error",
      status: "Failed",
      finishedAt: Date.now(),
      error: e.message || String(e),
    };
  }
}

// ─── HTML rendering ──────────────────────────────────────────────────

function renderPage(txPath: string, balPath: string): string {
  const txStore = loadJSON<TransactionStore>(txPath, { version: 1, last_extract: null, transactions: [] });
  const balStore = loadJSON<BalanceStore>(balPath, { version: 1, snapshots: [] });

  const txs = txStore.transactions;
  const bal = balStore.snapshots[0];
  const withDetails = txs.filter((t) => t.details_extracted);
  const allLineItems = withDetails.flatMap((t) => t.line_items || []);
  const denials = allLineItems.filter((li) => li.approval_status === "Denied");

  // Line-item-level metrics (the true picture)
  const paidItems = allLineItems.filter((li) => li.approval_status === "Paid");
  const submittedItems = allLineItems.filter((li) => li.approval_status === "Submitted");
  const paidAmt = paidItems.reduce((s, li) => s + (li.cost * li.quantity + li.tax_shipping), 0);
  const deniedValue = denials.reduce((s, d) => s + (d.cost * d.quantity + d.tax_shipping), 0);
  const denialRate = allLineItems.length > 0 ? ((denials.length / allLineItems.length) * 100).toFixed(1) : "0";

  // Transaction-level for items we don't have details on yet
  const txNoDetails = txs.filter((t) => !t.details_extracted);
  const completedNoDetailAmt = txNoDetails.filter((t) => t.status === "Complete").reduce((s, t) => s + t.amount, 0);
  const submittedNoDetailAmt = txNoDetails.filter((t) => t.status === "Submitted").reduce((s, t) => s + t.amount, 0);

  // Combined: use line-item data where available, transaction-level as fallback
  const totalPaid = paidAmt + completedNoDetailAmt;
  const submittedAmt = submittedItems.reduce((s, li) => s + (li.cost * li.quantity + li.tax_shipping), 0) + submittedNoDetailAmt;
  const remaining = bal ? bal.total_balance - totalPaid - submittedAmt - deniedValue : 0;

  const submitted = txs.filter((t) => t.status === "Submitted");
  const onHold = txs.filter((t) => t.status.toLowerCase().includes("hold"));

  const lastExtract = txStore.last_extract
    ? new Date(txStore.last_extract).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "Never";

  // Derive student/program names from data
  const studentName = txs.find((t) => t.student)?.student || "Step Up Student";
  const programName = txs.find((t) => t.category)?.category || "";

  const vendorMap = new Map<string, { total: number; count: number }>();
  for (const t of txs) {
    if (!t.vendor) continue;
    const v = vendorMap.get(t.vendor) || { total: 0, count: 0 };
    v.total += t.amount; v.count++;
    vendorMap.set(t.vendor, v);
  }
  const topVendors = [...vendorMap.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Step Up Scholarship Tracker</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f1419; color: #e7e9ea; line-height: 1.5; }
  .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
  h1 { font-size: 1.5rem; color: #e7e9ea; margin-bottom: 4px; }
  .subtitle { color: #71767b; font-size: 0.85rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1f26; border: 1px solid #2f3336; border-radius: 12px; padding: 16px; }
  .card-label { color: #71767b; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .card-value { font-size: 1.5rem; font-weight: 700; color: #e7e9ea; margin-top: 4px; }
  .card-value.green { color: #00ba7c; }
  .card-value.orange { color: #f59e0b; }
  .card-value.red { color: #f4212e; }
  .card-value.blue { color: #1d9bf0; }
  .card-sub { color: #71767b; font-size: 0.8rem; margin-top: 2px; }
  .section { background: #1a1f26; border: 1px solid #2f3336; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: #e7e9ea; }
  .section-title.red { color: #f4212e; }
  .section-title.orange { color: #f59e0b; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #71767b; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid #2f3336; font-size: 0.75rem; text-transform: uppercase; }
  td { padding: 8px 12px; border-bottom: 1px solid #1e2328; }
  tr:hover { background: #1e2328; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .status-complete { background: #00ba7c22; color: #00ba7c; }
  .status-submitted { background: #1d9bf022; color: #1d9bf0; }
  .status-draft { background: #71767b22; color: #71767b; }
  .status-denied { background: #f4212e22; color: #f4212e; }
  .status-paid { background: #00ba7c22; color: #00ba7c; }
  .status-hold { background: #f59e0b22; color: #f59e0b; }
  .amount { font-variant-numeric: tabular-nums; text-align: right; }
  .denial-reason { color: #f4212e; font-size: 0.8rem; font-style: italic; }
  .progress-bar { width: 100%; height: 8px; background: #2f3336; border-radius: 4px; margin-top: 8px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 4px; }
  .vendor-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .vendor-name { width: 140px; font-size: 0.8rem; color: #e7e9ea; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vendor-fill { height: 20px; background: #1d9bf044; border-radius: 3px; min-width: 2px; }
  .vendor-amt { font-size: 0.8rem; color: #71767b; font-variant-numeric: tabular-nums; }
  .update-panel { background: #1a1f26; border: 1px solid #2f3336; border-radius: 12px; padding: 12px 16px; }
  .update-btn { background: #1d9bf0; color: #fff; border: none; padding: 8px 20px; border-radius: 8px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .update-btn:hover { background: #1a8cd8; }
  .update-btn:disabled { background: #2f3336; color: #71767b; cursor: not-allowed; }
  .mfa-input { background: #0f1419; border: 1px solid #2f3336; color: #e7e9ea; padding: 8px 12px; border-radius: 8px; font-size: 1rem; width: 140px; text-align: center; letter-spacing: 0.15em; }
  .mfa-input:focus { outline: none; border-color: #1d9bf0; }
  .mfa-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .status-text { color: #71767b; font-size: 0.8rem; }
  .status-text.active { color: #f59e0b; }
  .status-text.done { color: #00ba7c; }
  .status-text.err { color: #f4212e; }
  .hidden { display: none; }
  @media (max-width: 600px) { .cards { grid-template-columns: 1fr 1fr; } .vendor-name { width: 100px; } header { flex-direction: column; gap: 12px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>Step Up Scholarship Tracker</h1>
      <div class="subtitle">${esc(studentName)} &middot; ${esc(programName)} &middot; Last pull: ${lastExtract}</div>
    </div>
    <div class="update-panel" id="updatePanel">
      <button class="update-btn" id="updateBtn" onclick="startExtract()">Update Data</button>
      <div id="statusRow" class="hidden">
        <div class="status-text" id="statusText"></div>
        <div class="mfa-row hidden" id="mfaRow">
          <input class="mfa-input" id="mfaCode" type="text" maxlength="10" placeholder="Code" inputmode="numeric" autocomplete="one-time-code">
          <button class="update-btn" onclick="submitMfa()" id="mfaBtn">Verify</button>
        </div>
      </div>
    </div>
  </header>

  <div class="cards">
    <div class="card">
      <div class="card-label">Award Balance</div>
      <div class="card-value">$${bal ? bal.total_balance.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "---"}</div>
    </div>
    <div class="card">
      <div class="card-label">Paid</div>
      <div class="card-value green">$${totalPaid.toFixed(2)}</div>
      <div class="card-sub">${paidItems.length} items paid</div>
    </div>
    <div class="card">
      <div class="card-label">Awaiting Review</div>
      <div class="card-value orange">$${submittedAmt.toFixed(2)}</div>
      <div class="card-sub">${submittedItems.length + txs.filter((t) => !t.details_extracted && t.status === "Submitted").length} items</div>
    </div>
    <div class="card">
      <div class="card-label">Denied</div>
      <div class="card-value${denials.length > 0 ? " red" : ""}">$${deniedValue.toFixed(2)}</div>
      <div class="card-sub">${denials.length} items denied</div>
    </div>
    <div class="card">
      <div class="card-label">Remaining (est.)</div>
      <div class="card-value blue">$${remaining.toFixed(2)}</div>
    </div>
  </div>

  ${bal ? `
  <div class="section">
    <div class="section-title">Budget Usage</div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${((totalPaid / bal.total_balance) * 100).toFixed(1)}%; background: #00ba7c;"></div>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 0.75rem; color: #71767b;">
      <span>$${totalPaid.toFixed(0)} used</span>
      <span>${((totalPaid / bal.total_balance) * 100).toFixed(0)}%</span>
      <span>$${bal.total_balance.toFixed(0)} total</span>
    </div>
  </div>` : ""}

  ${onHold.length > 0 ? `
  <div class="section" style="border-color: #f59e0b44;">
    <div class="section-title orange">On Hold - Action Required (${onHold.length})</div>
    <p style="color: #71767b; font-size: 0.8rem; margin-bottom: 8px;">Must respond within 30 days or auto-denied.</p>
    <table><tr><th>Date</th><th>Amount</th><th>Vendor</th><th>Days</th></tr>
    ${onHold.map((t) => `<tr><td>${t.date}</td><td class="amount">$${t.amount.toFixed(2)}</td><td>${esc(t.vendor)}</td><td>${daysSince(t.date)}d</td></tr>`).join("")}
    </table>
  </div>` : ""}

  ${denials.length > 0 ? `
  <div class="section" style="border-color: #f4212e44;">
    <div class="section-title red">Denials (${denials.length} items - $${deniedValue.toFixed(2)} lost)</div>
    <p style="color: #71767b; font-size: 0.8rem; margin-bottom: 8px;">Denial rate: ${denialRate}% of reviewed line items</p>
    <table><tr><th>ID</th><th>Submitted</th><th>Item</th><th>Amount</th><th>Review Time</th><th>Reason</th></tr>
    ${denials.map((d) => {
      const tx = withDetails.find((t) => t.line_items?.includes(d));
      const txId = tx?.id.replace("ema-", "") || "";
      const itemTotal = d.cost * d.quantity + d.tax_shipping;
      const reviewDays = d.status_changed_at && tx?.date ? daysBetween(tx.date, d.status_changed_at) + "d" : "-";
      return `<tr><td>${txId}</td><td>${tx?.date || ""}</td><td>${esc(d.description)}</td><td class="amount">$${itemTotal.toFixed(2)}</td><td>${reviewDays}</td><td><span class="denial-reason">${esc(d.denial_reason || "---")}</span></td></tr>`;
    }).join("")}
    </table>
  </div>` : ""}

  ${submitted.length > 0 ? `
  <div class="section">
    <div class="section-title">Awaiting Review (${submitted.length})</div>
    <table><tr><th>Date</th><th>Amount</th><th>Vendor</th><th>Days</th></tr>
    ${submitted.map((t) => `<tr><td>${t.date}</td><td class="amount">$${t.amount.toFixed(2)}</td><td>${esc(t.vendor)}</td><td>${daysSince(t.date)}d</td></tr>`).join("")}
    </table>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Top Vendors</div>
    ${topVendors.map(([name, v]) => {
      const pct = bal ? (v.total / bal.total_balance) * 100 : 0;
      return `<div class="vendor-bar"><span class="vendor-name">${esc(name)}</span><div class="vendor-fill" style="width: ${Math.max(pct * 3, 4)}px;"></div><span class="vendor-amt">$${v.total.toFixed(2)} (${v.count})</span></div>`;
    }).join("")}
  </div>

  <div class="section">
    <div class="section-title">All Transactions (${txs.length})</div>
    <table><tr><th>Date</th><th>ID</th><th>Amount</th><th>Vendor</th><th>Status</th><th>Items</th></tr>
    ${txs.map((t) => {
      const sc = t.status === "Complete" ? "complete" : t.status === "Submitted" ? "submitted" : t.status === "Draft" ? "draft" : "hold";
      const ic = t.has_denials ? `${t.line_items?.length || "-"} !` : `${t.line_items?.length || "-"}`;
      return `<tr><td>${t.date || "-"}</td><td>${t.id.replace("ema-", "")}</td><td class="amount">$${t.amount.toFixed(2)}</td><td>${esc(t.vendor)}</td><td><span class="status status-${sc}">${esc(t.status)}</span></td><td>${ic}</td></tr>`;
    }).join("")}
    </table>
  </div>

  <div style="text-align: center; color: #71767b; font-size: 0.75rem; padding: 20px;">
    ${withDetails.length}/${txs.length} transactions with details &middot; ${allLineItems.length} line items
  </div>
</div>

<script>
let pollInterval = null;

async function startExtract() {
  const btn = document.getElementById('updateBtn');
  const statusRow = document.getElementById('statusRow');
  const statusText = document.getElementById('statusText');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  statusRow.classList.remove('hidden');
  statusText.textContent = 'Starting extract...';
  statusText.className = 'status-text active';

  const res = await fetch('/api/extract/start', { method: 'POST' });
  const data = await res.json();
  if (data.error) {
    statusText.textContent = data.error;
    statusText.className = 'status-text err';
    btn.disabled = false;
    btn.textContent = 'Update Data';
    return;
  }

  pollInterval = setInterval(pollStatus, 1500);
}

async function pollStatus() {
  const res = await fetch('/api/extract/status');
  const data = await res.json();
  const statusText = document.getElementById('statusText');
  const mfaRow = document.getElementById('mfaRow');
  const btn = document.getElementById('updateBtn');

  statusText.textContent = data.status;

  if (data.phase === 'waiting_mfa') {
    statusText.className = 'status-text active';
    mfaRow.classList.remove('hidden');
    document.getElementById('mfaCode').focus();
  } else if (data.phase === 'complete') {
    clearInterval(pollInterval);
    statusText.textContent = 'Done! ' + (data.result || '');
    statusText.className = 'status-text done';
    mfaRow.classList.add('hidden');
    btn.textContent = 'Update Data';
    btn.disabled = false;
    setTimeout(() => location.reload(), 2000);
  } else if (data.phase === 'error') {
    clearInterval(pollInterval);
    statusText.textContent = 'Error: ' + (data.error || 'Unknown');
    statusText.className = 'status-text err';
    mfaRow.classList.add('hidden');
    btn.textContent = 'Update Data';
    btn.disabled = false;
  } else {
    statusText.className = 'status-text active';
  }
}

async function submitMfa() {
  const code = document.getElementById('mfaCode').value.trim();
  if (!code) return;
  document.getElementById('mfaBtn').disabled = true;
  await fetch('/api/extract/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  document.getElementById('mfaRow').classList.add('hidden');
  document.getElementById('mfaBtn').disabled = false;
  document.getElementById('mfaCode').value = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement?.id === 'mfaCode') submitMfa();
});
</script>
</body>
</html>`;
}

function daysSince(dateStr: string): number {
  if (!dateStr) return 0;
  let d: Date;
  if (dateStr.includes("/")) {
    const [m, day, y] = dateStr.split("/");
    d = new Date(`${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`);
  } else { d = new Date(dateStr); }
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function daysBetween(dateStr: string, isoStr: string): number {
  const start = dateStr.includes("/")
    ? (() => { const [m, d, y] = dateStr.split("/"); return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`); })()
    : new Date(dateStr);
  const end = new Date(isoStr);
  return Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
