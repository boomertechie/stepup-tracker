import { writeFileSync } from "fs";
import { resolve } from "path";
import type { Transaction, TransactionStore, BalanceStore, LineItem } from "./types";

// ─── Dashboard (all-in-one view) ─────────────────────────────────────

export function reportDashboard(
  txStore: TransactionStore,
  balStore: BalanceStore
): void {
  const txs = txStore.transactions;
  const latestBal = balStore.snapshots[0];
  const withDetails = txs.filter((t) => t.details_extracted);
  const allLineItems = withDetails.flatMap((t) => t.line_items || []);

  // ── Header
  console.log("\n  Step Up Scholarship Tracker");
  console.log("  " + "=".repeat(42));

  // ── Balance
  if (latestBal) {
    console.log(`\n  Award Balance         $${latestBal.total_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  }

  // ── Reimbursement totals
  const completedAmt = txs.filter((t) => t.status === "Complete").reduce((s, t) => s + t.amount, 0);
  const submittedAmt = txs.filter((t) => t.status === "Submitted").reduce((s, t) => s + t.amount, 0);
  const draftAmt = txs.filter((t) => t.status === "Draft").reduce((s, t) => s + t.amount, 0);

  console.log(`  Reimbursed (Complete) $${completedAmt.toFixed(2)}`);
  console.log(`  Awaiting Review       $${submittedAmt.toFixed(2)}`);
  if (draftAmt > 0) console.log(`  Drafts                $${draftAmt.toFixed(2)}`);

  // ── Remaining estimate
  if (latestBal) {
    const remaining = latestBal.total_balance - completedAmt - submittedAmt;
    console.log(`  ────────────────────────────────────────`);
    console.log(`  Remaining (est.)      $${remaining.toFixed(2)}`);
  }

  // ── Pending items needing attention
  const submitted = txs.filter((t) => t.status === "Submitted");
  const onHold = txs.filter((t) => t.status.toLowerCase().includes("hold"));

  if (submitted.length > 0 || onHold.length > 0) {
    console.log(`\n  Awaiting Review (${submitted.length})`);
    console.log("  " + "-".repeat(42));
    for (const t of submitted.slice(0, 8)) {
      const age = daysSince(t.date);
      console.log(`  ${t.date}  $${t.amount.toFixed(2).padStart(8)}  ${t.vendor.substring(0, 22).padEnd(22)}  ${age}d`);
    }
    if (submitted.length > 8) console.log(`  ... and ${submitted.length - 8} more`);
  }

  if (onHold.length > 0) {
    console.log(`\n  ON HOLD - ACTION REQUIRED (${onHold.length})`);
    console.log("  " + "-".repeat(42));
    for (const t of onHold) {
      const age = daysSince(t.date);
      const urgency = age > 20 ? " ** EXPIRING **" : "";
      console.log(`  ${t.date}  $${t.amount.toFixed(2).padStart(8)}  ${t.vendor}${urgency}`);
    }
    console.log("  Reminder: 30 days to respond or auto-denied.");
  }

  // ── Denial summary
  const denials = allLineItems.filter((li) => li.approval_status === "Denied");
  if (denials.length > 0) {
    const deniedValue = denials.reduce((s, d) => s + (d.cost * d.quantity + d.tax_shipping), 0);
    const denialRate = allLineItems.length > 0
      ? ((denials.length / allLineItems.length) * 100).toFixed(1) : "0";

    console.log(`\n  Denials`);
    console.log("  " + "-".repeat(42));
    console.log(`  ${denials.length} line items denied ($${deniedValue.toFixed(2)} lost)`);
    console.log(`  Denial rate: ${denialRate}% of reviewed items`);

    // Top denial reasons
    const byReason = groupBy(denials, (d) => d.denial_reason || "(no reason)");
    const topReasons = Object.entries(byReason)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);
    for (const [reason, items] of topReasons) {
      console.log(`  ${items.length}x  ${reason.substring(0, 60)}`);
    }
  }

  // ── Vendor breakdown (top 5)
  const byVendor = groupBy(txs.filter((t) => t.vendor), (t) => t.vendor);
  const topVendors = Object.entries(byVendor)
    .map(([v, items]) => ({ vendor: v, total: items.reduce((s, t) => s + t.amount, 0), count: items.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  console.log(`\n  Top Vendors`);
  console.log("  " + "-".repeat(42));
  for (const v of topVendors) {
    console.log(`  $${v.total.toFixed(2).padStart(8)}  ${v.vendor} (${v.count})`);
  }

  // ── Data coverage
  console.log(`\n  Data Coverage`);
  console.log("  " + "-".repeat(42));
  console.log(`  Transactions: ${txs.length} total, ${withDetails.length} with details`);
  console.log(`  Line items:   ${allLineItems.length} extracted`);
  if (txStore.last_extract) {
    console.log(`  Last pull:    ${new Date(txStore.last_extract).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`);
  }

  console.log();
}

// ─── Markdown export ─────────────────────────────────────────────────

export function exportMarkdown(
  txStore: TransactionStore,
  balStore: BalanceStore,
  outputPath: string
): void {
  const txs = txStore.transactions;
  const latestBal = balStore.snapshots[0];
  const withDetails = txs.filter((t) => t.details_extracted);
  const allLineItems = withDetails.flatMap((t) => t.line_items || []);
  const denials = allLineItems.filter((li) => li.approval_status === "Denied");
  const now = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`# Step Up Scholarship Tracker`);
  w(`**Generated:** ${now}  `);
  const studentName = txs.find((t) => t.student)?.student || "Student";
  const programName = txs.find((t) => t.category)?.category || "";
  w(`**Student:** ${studentName}  `);
  if (programName) w(`**Program:** ${programName}`);
  w(``);

  // Balance
  w(`## Balance`);
  w(``);
  if (latestBal) {
    const completedAmt = txs.filter((t) => t.status === "Complete").reduce((s, t) => s + t.amount, 0);
    const submittedAmt = txs.filter((t) => t.status === "Submitted").reduce((s, t) => s + t.amount, 0);
    const remaining = latestBal.total_balance - completedAmt - submittedAmt;

    w(`| Metric | Amount |`);
    w(`|--------|--------|`);
    w(`| Award Balance | $${latestBal.total_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })} |`);
    w(`| Reimbursed (Complete) | $${completedAmt.toFixed(2)} |`);
    w(`| Awaiting Review | $${submittedAmt.toFixed(2)} |`);
    w(`| **Remaining (est.)** | **$${remaining.toFixed(2)}** |`);
  }
  w(``);

  // Pending
  const submitted = txs.filter((t) => t.status === "Submitted");
  const onHold = txs.filter((t) => t.status.toLowerCase().includes("hold"));

  if (submitted.length > 0) {
    w(`## Awaiting Review (${submitted.length})`);
    w(``);
    w(`| Date | Amount | Vendor | Days Waiting |`);
    w(`|------|--------|--------|-------------|`);
    for (const t of submitted) {
      const age = daysSince(t.date);
      w(`| ${t.date} | $${t.amount.toFixed(2)} | ${t.vendor} | ${age} |`);
    }
    w(``);
  }

  if (onHold.length > 0) {
    w(`## ON HOLD - Action Required`);
    w(``);
    w(`> 30 days to respond or auto-denied.`);
    w(``);
    w(`| Date | Amount | Vendor | Days | Urgency |`);
    w(`|------|--------|--------|------|---------|`);
    for (const t of onHold) {
      const age = daysSince(t.date);
      const urg = age > 20 ? "EXPIRING" : "OK";
      w(`| ${t.date} | $${t.amount.toFixed(2)} | ${t.vendor} | ${age} | ${urg} |`);
    }
    w(``);
  }

  // Denials
  if (denials.length > 0) {
    const deniedValue = denials.reduce((s, d) => s + (d.cost * d.quantity + d.tax_shipping), 0);
    const denialRate = allLineItems.length > 0
      ? ((denials.length / allLineItems.length) * 100).toFixed(1) : "0";

    w(`## Denials`);
    w(``);
    w(`**${denials.length} items denied** | $${deniedValue.toFixed(2)} lost | ${denialRate}% denial rate`);
    w(``);
    w(`| Date | Reimbursement | Item | Amount | Reason |`);
    w(`|------|--------------|------|--------|--------|`);

    for (const tx of withDetails) {
      for (const item of tx.line_items || []) {
        if (item.approval_status !== "Denied") continue;
        const itemTotal = item.cost * item.quantity + item.tax_shipping;
        w(`| ${tx.date} | #${tx.id.replace("ema-", "")} | ${item.description} | $${itemTotal.toFixed(2)} | ${item.denial_reason || "-"} |`);
      }
    }
    w(``);
  }

  // All transactions table
  w(`## All Transactions`);
  w(``);
  w(`| Date | ID | Amount | Vendor | Status | Items |`);
  w(`|------|----|--------|--------|--------|-------|`);
  for (const t of txs) {
    const itemCount = t.line_items?.length || "-";
    const hasDenials = t.has_denials ? " (has denials)" : "";
    w(`| ${t.date || "-"} | ${t.id.replace("ema-", "")} | $${t.amount.toFixed(2)} | ${t.vendor} | ${t.status}${hasDenials} | ${itemCount} |`);
  }
  w(``);

  // Monthly summary
  w(`## Monthly Summary`);
  w(``);
  const byMonth = groupBy(txs.filter((t) => t.date), (t) => toYearMonth(t.date));
  const months = Object.keys(byMonth).sort().reverse();
  w(`| Month | Count | Amount |`);
  w(`|-------|-------|--------|`);
  for (const month of months) {
    if (month === "unknown") continue;
    const items = byMonth[month];
    const total = items.reduce((s, t) => s + t.amount, 0);
    w(`| ${month} | ${items.length} | $${total.toFixed(2)} |`);
  }
  w(``);

  const content = lines.join("\n");
  writeFileSync(outputPath, content + "\n");
  console.log(`Report exported to: ${outputPath}`);
}

// ─── Individual reports ──────────────────────────────────────────────

export function reportSummary(
  txStore: TransactionStore,
  balStore: BalanceStore
): void {
  const txs = txStore.transactions;
  const latestBal = balStore.snapshots[0];

  console.log("\n=== Step Up Scholarship Summary ===\n");

  if (latestBal) {
    console.log(`Balance (${latestBal.date}):`);
    console.log(`  Available:  $${latestBal.available_balance.toFixed(2)}`);
    console.log(`  Total:      $${latestBal.total_balance.toFixed(2)}`);
    if (latestBal.pending_amount > 0) {
      console.log(`  Pending:    $${latestBal.pending_amount.toFixed(2)}`);
    }
    console.log();
  }

  console.log(`Total transactions: ${txs.length}`);

  if (txs.length > 0) {
    const completedAmount = txs
      .filter((t) => t.status.toLowerCase() === "complete")
      .reduce((sum, t) => sum + t.amount, 0);
    const pendingAmount = txs
      .filter((t) => t.status.toLowerCase() !== "complete" && t.status.toLowerCase() !== "draft")
      .reduce((sum, t) => sum + t.amount, 0);
    const totalAmount = txs.reduce((sum, t) => sum + t.amount, 0);

    console.log(`Total reimbursed:   $${completedAmount.toFixed(2)}`);
    console.log(`Pending approval:   $${pendingAmount.toFixed(2)}`);
    console.log(`All submissions:    $${totalAmount.toFixed(2)}`);

    const byStatus = groupBy(txs, (t) => t.status);
    console.log("\nBy status:");
    for (const [status, items] of Object.entries(byStatus)) {
      console.log(`  ${status || "unknown"}: ${items.length}`);
    }

    if (txStore.last_extract) {
      console.log(`\nLast extracted: ${txStore.last_extract}`);
    }
  }
  console.log();
}

export function reportMonthly(txStore: TransactionStore): void {
  const txs = txStore.transactions;
  if (txs.length === 0) { console.log("No transactions."); return; }

  console.log("\n=== Monthly Breakdown ===\n");
  const byMonth = groupBy(txs, (t) => toYearMonth(t.date));
  const months = Object.keys(byMonth).sort().reverse();

  for (const month of months) {
    const items = byMonth[month];
    const received = items.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    console.log(`${month}: ${items.length} transactions`);
    if (received) console.log(`  Received: $${received.toFixed(2)}`);
    const byCat = groupBy(items, (t) => t.category);
    for (const [cat, catItems] of Object.entries(byCat)) {
      const catTotal = catItems.reduce((s, t) => s + Math.abs(t.amount), 0);
      console.log(`    ${cat || "uncategorized"}: $${catTotal.toFixed(2)} (${catItems.length})`);
    }
    console.log();
  }
}

export function reportCategory(txStore: TransactionStore): void {
  const txs = txStore.transactions;
  if (txs.length === 0) { console.log("No transactions."); return; }

  console.log("\n=== Category Breakdown ===\n");
  const byCat = groupBy(txs, (t) => t.category || "uncategorized");
  const sorted = Object.entries(byCat).sort(
    (a, b) => b[1].reduce((s, t) => s + Math.abs(t.amount), 0) - a[1].reduce((s, t) => s + Math.abs(t.amount), 0)
  );
  for (const [cat, items] of sorted) {
    const total = items.reduce((s, t) => s + Math.abs(t.amount), 0);
    console.log(`${cat}: $${total.toFixed(2)} (${items.length} transactions)`);
  }
  console.log();
}

export function reportPending(txStore: TransactionStore): void {
  const pending = txStore.transactions.filter((t) =>
    ["pending", "on_hold", "on hold", "submitted", "in review"].includes(t.status.toLowerCase())
  );

  console.log("\n=== Pending / On-Hold Items ===\n");
  if (pending.length === 0) { console.log("No pending items."); return; }

  for (const t of pending) {
    const age = daysSince(t.date);
    const urgency = t.status.toLowerCase().includes("hold") && age > 20 ? " ** EXPIRING SOON **" : "";
    console.log(`  ${t.date} | $${Math.abs(t.amount).toFixed(2)} | ${t.vendor} | ${t.status}${urgency}`);
    if (t.description && t.description !== t.vendor) {
      console.log(`    ${t.description}`);
    }
  }

  const onHold = pending.filter((t) => t.status.toLowerCase().includes("hold"));
  if (onHold.length > 0) {
    console.log(`\nReminder: On-hold items must be resolved within 30 days or they are denied.`);
  }
  console.log();
}

export function reportDenials(txStore: TransactionStore): void {
  console.log("\n=== Denial Report ===\n");

  const withDetails = txStore.transactions.filter((t) => t.details_extracted && t.line_items?.length);
  if (withDetails.length === 0) {
    console.log("No detail data available. Run: bun run index.ts extract");
    return;
  }

  const denials: { tx: Transaction; item: LineItem }[] = [];
  for (const tx of withDetails) {
    for (const item of tx.line_items || []) {
      if (item.approval_status === "Denied") denials.push({ tx, item });
    }
  }

  if (denials.length === 0) { console.log("No denials found."); return; }

  console.log(`Total denied line items: ${denials.length}\n`);

  const byReason = groupBy(denials, (d) => d.item.denial_reason || "(no reason given)");
  console.log("By reason:");
  for (const [reason, items] of Object.entries(byReason)) {
    const totalLost = items.reduce((s, d) => s + (d.item.cost * d.item.quantity + d.item.tax_shipping), 0);
    console.log(`  $${totalLost.toFixed(2)} lost | ${items.length}x | ${reason}`);
  }

  console.log("\nAll denials:");
  for (const { tx, item } of denials) {
    const itemTotal = item.cost * item.quantity + item.tax_shipping;
    console.log(`  ${tx.date} | #${tx.id.replace("ema-", "")} | $${itemTotal.toFixed(2)} | ${item.description}`);
    console.log(`    Vendor: ${item.vendor} | Category: ${item.category} / ${item.type}`);
    if (item.denial_reason) console.log(`    Reason: ${item.denial_reason}`);
  }

  const totalDenied = denials.reduce((s, d) => s + (d.item.cost * d.item.quantity + d.item.tax_shipping), 0);
  const allLineItems = withDetails.flatMap((t) => t.line_items || []);
  const denialRate = allLineItems.length > 0 ? ((denials.length / allLineItems.length) * 100).toFixed(1) : "0";

  console.log(`\nDenial rate: ${denials.length}/${allLineItems.length} line items (${denialRate}%)`);
  console.log(`Total value denied: $${totalDenied.toFixed(2)}`);
  console.log();
}

// ─── Utilities ───────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

function daysSince(dateStr: string): number {
  if (!dateStr) return 0;
  const d = parseDate(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function parseDate(dateStr: string): Date {
  if (dateStr.includes("/")) {
    const [m, d, y] = dateStr.split("/");
    return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  }
  return new Date(dateStr);
}

function toYearMonth(dateStr: string): string {
  if (!dateStr) return "unknown";
  if (dateStr.includes("/")) {
    const [m, , y] = dateStr.split("/");
    return `${y}-${m.padStart(2, "0")}`;
  }
  return dateStr.substring(0, 7);
}
