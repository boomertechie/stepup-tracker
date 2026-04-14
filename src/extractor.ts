import { type Page } from "playwright-core";
import { launchAndLogin, type PromptFn } from "./auth";
import type { TrackerConfig, Transaction, BalanceSnapshot, LineItem } from "./types";

/**
 * Discovery mode: headless portal exploration.
 * Authenticates inline (same browser session), dumps page structure.
 */
export async function discover(config: TrackerConfig): Promise<void> {
  const { context, page } = await launchAndLogin(config);

  console.log(`\nLogged in. URL: ${page.url()}\n`);

  console.log("=== LANDING PAGE ===");
  await dumpPageSummary(page);

  console.log("\n=== NAVIGATION LINKS ===");
  await dumpClickableElements(page);

  console.log("\n=== TABLES ON PAGE ===");
  await dumpTables(page);

  await context.close();
  console.log("\nDiscovery complete.");
}

/**
 * Extract reimbursement transactions and balance from the EMA portal.
 *
 * Navigation flow (all SPA clicks, no page.goto):
 *   Dashboard → "My Students" (balance) → "Reimbursements" (transactions)
 */
const TERMINAL_STATUSES = new Set(["Paid", "Denied"]);

function needsDetailRefresh(tx: Transaction, existing?: Transaction): boolean {
  if (tx.status === "Draft") return false;
  if (!existing?.details_extracted) return true;
  const items = existing.line_items || [];
  if (items.length === 0) return true;
  // Re-pull if any line item is still in a non-terminal status
  if (items.some((li) => !TERMINAL_STATUSES.has(li.approval_status))) return true;
  // Re-pull if any denied item is missing its denial reason
  if (items.some((li) => li.approval_status === "Denied" && !li.denial_reason)) return true;
  return false;
}

export async function extract(
  config: TrackerConfig,
  promptFn?: PromptFn,
  onStatus?: (status: string) => void,
  existingTransactions?: Transaction[],
): Promise<{
  transactions: Transaction[];
  balance: BalanceSnapshot | null;
}> {
  const log = (msg: string) => { console.error(msg); onStatus?.(msg); };
  const { context, page } = await launchAndLogin(config, promptFn, onStatus);

  try {
    console.error(`Logged in. URL: ${page.url()}`);

    // --- Extract balance from My Students page ---
    const balance = await extractBalance(page);
    if (balance) {
      console.error(`Award: $${balance.total_balance.toFixed(2)}`);
    }

    // --- Extract transactions from Reimbursements page ---
    const transactions = await extractTransactions(page, existingTransactions);
    console.error(`Extracted ${transactions.length} transactions`);

    return { transactions, balance };
  } finally {
    await context.close();
  }
}

// ─── SPA navigation ─────────────────────────────────────────────────

async function clickNav(page: Page, linkText: string): Promise<void> {
  console.error(`Navigating to ${linkText}...`);
  await page.locator(`a.nav-link:has-text("${linkText}")`).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
}

// ─── Balance extraction (from /MyStudents) ───────────────────────────

async function extractBalance(page: Page): Promise<BalanceSnapshot | null> {
  try {
    await clickNav(page, "My Students");

    // Look for "Program Award Amount: $X,XXX.XX"
    const awardEl = await page
      .locator('text=/Program Award Amount/')
      .first()
      .textContent({ timeout: 10000 })
      .catch(() => null);

    if (!awardEl) {
      console.error("Could not find Program Award Amount on My Students page");
      return null;
    }

    const amount = parseAmount(awardEl);
    return {
      date: new Date().toISOString().split("T")[0],
      total_balance: amount,
      available_balance: amount,
      pending_amount: 0,
      extracted_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`Balance extraction failed: ${e}`);
    return null;
  }
}

// ─── Transaction extraction (from /Reimbursement) ────────────────────
//
// Radzen grid: table.rz-grid-table
// Columns: [empty] | ID | Program | Date | Provider | Student | Amount | Status | View | Receipts
// Indices:    0       1      2        3       4          5        6        7       8       9

async function extractTransactions(page: Page, existingTransactions?: Transaction[]): Promise<Transaction[]> {
  await clickNav(page, "Reimbursements");

  try {
    await page.waitForSelector("table.rz-grid-table", { timeout: 15000 });
  } catch {
    console.error("Reimbursement table did not load");
    return [];
  }
  await page.waitForTimeout(2000);

  // Build lookup of existing data
  const existingById = new Map<string, Transaction>();
  if (existingTransactions) {
    for (const t of existingTransactions) existingById.set(t.id, t);
  }

  // Single-pass: read table page → extract details for rows that need it → paginate → repeat
  const transactions: Transaction[] = [];
  const txById = new Map<string, Transaction>();
  let tablePageNum = 1;

  while (true) {
    console.error(`Table page ${tablePageNum}...`);

    // Read all rows on current table page
    const rows = await page.locator("table.rz-grid-table tbody tr").all();
    console.error(`  Found ${rows.length} rows`);

    const pageTransactions: Transaction[] = [];
    for (let r = 0; r < rows.length; r++) {
      const cells = await rows[r].locator("td").allTextContents();
      if (cells.length < 8) continue;
      const id = cells[1]?.trim();
      if (!id) continue;

      const tx: Transaction = {
        id: `ema-${id}`,
        date: cells[3]?.trim() || "",
        type: "reimbursement",
        amount: parseAmount(cells[6] || "0"),
        vendor: cells[4]?.trim() || "",
        category: cells[2]?.trim() || "",
        status: cells[7]?.trim() || "",
        description: `${cells[4]?.trim()} - ${cells[2]?.trim()}`,
        student: cells[5]?.trim() || "",
        extracted_at: new Date().toISOString(),
      };
      pageTransactions.push(tx);
      txById.set(tx.id, tx);
    }

    transactions.push(...pageTransactions);
    console.error(`  Parsed ${pageTransactions.length} transactions`);

    // Determine which rows on THIS page need detail extraction
    const needsIds = new Set<string>();
    for (const t of pageTransactions) {
      if (needsDetailRefresh(t, existingById.get(t.id))) {
        needsIds.add(t.id.replace("ema-", ""));
      }
    }

    if (needsIds.size > 0) {
      console.error(`  Extracting details for ${needsIds.size} (skipping ${pageTransactions.length - needsIds.size} finalized)...`);
      let extracted = 0;

      while (needsIds.size > 0) {
        // Re-scan current table rows after each Detail/Back cycle
        const currentRows = await page.locator("table.rz-grid-table tbody tr").all();
        let foundOne = false;

        for (const row of currentRows) {
          const cells = await row.locator("td").allTextContents();
          const rowId = cells[1]?.trim();
          if (!rowId || !needsIds.has(rowId)) continue;

          const detailBtn = row.locator("text=Details").first();
          if (!await detailBtn.isVisible().catch(() => false)) continue;

          extracted++;
          console.error(`    [${extracted}] Details for #${rowId}...`);
          await detailBtn.click();
          await page.waitForTimeout(2000);

          const tx = txById.get(`ema-${rowId}`);
          if (tx) {
            tx.detail_url = page.url();
            tx.line_items = await extractLineItems(page);
            tx.has_denials = tx.line_items.some((li) => li.approval_status === "Denied");
            tx.details_extracted = true;
          }

          needsIds.delete(rowId);

          // Navigate back to table
          await page.locator(".reimbursement-back-button").click();
          await page.waitForSelector("table.rz-grid-table", { timeout: 10000 });
          await page.waitForTimeout(1500);
          foundOne = true;
          break; // Re-scan from scratch
        }

        if (!foundOne) {
          console.error(`    ${needsIds.size} rows not found after re-scan, moving on`);
          break;
        }
      }
    } else {
      console.error(`  All ${pageTransactions.length} finalized, no details needed`);
    }

    // Check for next table page
    const nextBtn = page.locator(".rz-paginator button.rz-paginator-next, button[aria-label='Next']").first();
    const nextDisabled = await nextBtn.isDisabled().catch(() => true);
    const nextVisible = await nextBtn.isVisible().catch(() => false);
    if (!nextVisible || nextDisabled) break;

    console.error(`  Advancing to table page ${tablePageNum + 1}...`);
    await nextBtn.click();
    await page.waitForTimeout(2000);
    tablePageNum++;
  }

  console.error(`Total: ${transactions.length} transactions across ${tablePageNum} page(s)`);
  return transactions;
}

// ─── Line item extraction (from detail page) ────────────────────────

async function extractLineItems(page: Page): Promise<LineItem[]> {
  const items: LineItem[] = [];

  const headers = await page.locator(".line-item-header").all();

  for (let i = 0; i < headers.length; i++) {
    // Extract approval status from the header
    const statusEl = await headers[i].locator(".line-item-status").textContent().catch(() => "");
    const approvalStatus = statusEl?.replace("APPROVAL STATUS", "").trim() || "";

    // Get all the info fields that belong to this line item
    // They're siblings after the header, up until the next header
    // Use the container approach: get all .line-item-info within the same parent section
    const item: LineItem = {
      purchase_number: i + 1,
      category: "",
      type: "",
      description: "",
      purchase_date: "",
      quantity: 0,
      cost: 0,
      tax_shipping: 0,
      vendor: "",
      approval_status: approvalStatus,
      denial_reason: "",
      invoice_number: "",
      educational_benefit: "",
      item_url: "",
    };

    items.push(item);
  }

  // Now extract all line-item-info fields and distribute them across line items
  // Each line item has the same set of fields in order
  const allInfos = await page.locator(".line-item-info").all();
  const fieldsPerItem = headers.length > 0 ? Math.floor(allInfos.length / headers.length) : 0;

  for (let i = 0; i < allInfos.length; i++) {
    const itemIndex = Math.floor(i / fieldsPerItem);
    if (itemIndex >= items.length) break;

    const label = (await allInfos[i].locator(".line-item-label").textContent().catch(() => ""))?.trim() || "";
    const value = (await allInfos[i].locator(".line-item-value").textContent().catch(() => ""))?.trim() || "";

    const item = items[itemIndex];
    switch (label) {
      case "Purchase Date": item.purchase_date = value; break;
      case "Invoice #": item.invoice_number = value; break;
      case "Category": item.category = value; break;
      case "Type": item.type = value; break;
      case "Description": item.description = value; break;
      case "Quantity": item.quantity = parseInt(value) || 0; break;
      case "Cost per Item/Service": item.cost = parseAmount(value); break;
      case "Tax, Shipping, etc.": item.tax_shipping = parseAmount(value); break;
      case "Who did you pay?": item.vendor = value; break;
      case "Item/Service URL": item.item_url = value === "-" ? "" : value; break;
      case "How will this item/service help your student learn?": item.educational_benefit = value; break;
    }
  }

  // Extract denial reasons via DOM — find all "Reason for Denial:" labels and grab adjacent text
  const denialLabels = await page.locator("p.font-weight-bold, strong, b, span").filter({ hasText: "Reason for Denial" }).all();
  console.error(`    Found ${denialLabels.length} denial reason label(s)`);

  const reasons: string[] = [];
  for (const label of denialLabels) {
    // Get the parent container's full text — the reason + comments follow the label
    const parent = label.locator("..");
    const parentText = (await parent.textContent().catch(() => ""))?.trim() || "";
    // Strip the label itself
    let reason = parentText.replace(/Reason for Denial:\s*/i, "").trim();
    // Also try: the next sibling element
    if (!reason || reason.length < 3) {
      const nextText = await label.evaluate((el) => {
        let node = el.nextSibling;
        let text = "";
        while (node) {
          text += node.textContent || "";
          node = node.nextSibling;
        }
        return text;
      }).catch(() => "");
      if (nextText?.trim()) reason = nextText.trim();
    }
    // Split "Not an approved expenseComments: ..." into structured reason
    const commentIdx = reason.indexOf("Comments:");
    if (commentIdx !== -1) {
      const shortReason = reason.substring(0, commentIdx).trim();
      const comment = reason.substring(commentIdx + "Comments:".length).trim();
      reason = `${shortReason} — ${comment}`;
    }
    reason = reason.replace(/\s*APPEAL\s*$/, "").replace(/\s*PURCHASE \d.*$/s, "").trim();
    if (reason) {
      console.error(`    Denial reason: "${reason.substring(0, 80)}..."`);
      reasons.push(reason);
    }
  }

  // Assign reasons to denied items in order
  let denialIndex = 0;
  for (const reason of reasons) {
    while (denialIndex < items.length && items[denialIndex].approval_status !== "Denied") {
      denialIndex++;
    }
    if (denialIndex < items.length) {
      items[denialIndex].denial_reason = reason;
      denialIndex++;
    }
  }

  return items;
}

// ─── Discovery helpers ───────────────────────────────────────────────

async function dumpPageSummary(page: Page): Promise<void> {
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  const dollarElements = await page.locator('text=/\\$[\\d,]+\\.\\d{2}/').all();
  if (dollarElements.length > 0) {
    console.log(`\nDollar amounts found:`);
    for (const el of dollarElements) {
      const text = await el.textContent().catch(() => "");
      const parent = await el
        .evaluate((e) => {
          const p = e.closest("[class]");
          return p ? `<${p.tagName} class="${p.className}">` : "<unknown>";
        })
        .catch(() => "");
      if (text?.trim()) console.log(`  ${text.trim()} (in ${parent})`);
    }
  }

  const headings = await page.locator("h1, h2, h3, h4").all();
  if (headings.length > 0) {
    console.log(`\nHeadings:`);
    for (const h of headings) {
      const tag = await h.evaluate((el) => el.tagName);
      const text = await h.textContent().catch(() => "");
      if (text?.trim()) console.log(`  <${tag}> ${text.trim()}`);
    }
  }
}

async function dumpClickableElements(page: Page): Promise<void> {
  const elements = await page
    .locator("a, button, [role=link], [role=button], [role=tab], [role=menuitem]")
    .all();
  let count = 0;
  for (const el of elements) {
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const text = (await el.textContent().catch(() => ""))?.trim();
    if (!text) continue;
    const tag = await el.evaluate((e) => e.tagName).catch(() => "?");
    const href = await el.getAttribute("href").catch(() => null);
    const id = await el.getAttribute("id").catch(() => null);
    const cls = await el.evaluate((e) => e.className).catch(() => "");
    const idStr = id ? ` id="${id}"` : "";
    const clsStr = cls ? ` class="${cls}"` : "";
    console.log(
      `  [${count}] <${tag}${idStr}${clsStr}> "${text}"${href ? ` -> ${href}` : ""}`
    );
    count++;
  }
  console.log(`Total: ${count} visible clickable elements`);
}

async function dumpTables(page: Page): Promise<void> {
  const tables = await page.locator("table").all();
  console.log(`Found ${tables.length} table(s)`);
  for (let t = 0; t < tables.length; t++) {
    const id = await tables[t].getAttribute("id").catch(() => null);
    const cls = await tables[t].evaluate((e) => e.className).catch(() => "");
    console.log(
      `\n  Table ${t}${id ? ` id="${id}"` : ""}${cls ? ` class="${cls}"` : ""}:`
    );

    const headers = await tables[t].locator("th").allTextContents();
    console.log(`    Columns: [${headers.map((h) => h.trim()).join(", ")}]`);

    const rows = await tables[t].locator("tbody tr").all();
    const preview = Math.min(rows.length, 5);
    for (let r = 0; r < preview; r++) {
      const cells = await rows[r].locator("td").allTextContents();
      console.log(`    Row ${r}: ${cells.map((c) => c.trim()).join(" | ")}`);
    }
    if (rows.length > 5)
      console.log(`    ... and ${rows.length - 5} more rows`);
    console.log(`    Total rows: ${rows.length}`);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

function parseAmount(text: string): number {
  const match = text.match(/\$?([\d,]+\.?\d*)/);
  if (!match) return 0;
  return parseFloat(match[1].replace(/,/g, "")) || 0;
}
