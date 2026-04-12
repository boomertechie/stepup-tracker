import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  Transaction,
  TransactionStore,
  BalanceSnapshot,
  BalanceStore,
  LineItem,
} from "./types";

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Transactions ────────────────────────────────────────────────────

export function loadTransactions(path: string): TransactionStore {
  if (!existsSync(path)) {
    return { version: 1, last_extract: null, transactions: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveTransactions(path: string, store: TransactionStore): void {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export function mergeTransactions(
  existing: Transaction[],
  incoming: Transaction[]
): { merged: Transaction[]; added: number; updated: number } {
  const byId = new Map<string, Transaction>();

  for (const t of existing) byId.set(t.id, t);

  let added = 0;
  let updated = 0;

  for (const t of incoming) {
    const prev = byId.get(t.id);
    if (!prev) {
      byId.set(t.id, t);
      added++;
    } else {
      const now = new Date().toISOString();
      const statusChanged = prev.status !== t.status;
      const amountChanged = prev.amount !== t.amount;
      const hasNewDetails = t.details_extracted && !prev.details_extracted;
      const lineItemStatusChanged = hasLineItemStatusChanges(prev, t);

      if (statusChanged || amountChanged || hasNewDetails || lineItemStatusChanged) {
        const merged = { ...prev, ...t, extracted_at: now };

        // Track transaction-level status change
        if (statusChanged) {
          merged.status_changed_at = now;
          merged.previous_status = prev.status;
        } else {
          merged.status_changed_at = prev.status_changed_at;
          merged.previous_status = prev.previous_status;
        }

        // Track line-item-level status changes
        if (t.line_items && prev.line_items) {
          merged.line_items = mergeLineItemStatuses(prev.line_items, t.line_items, now);
        }

        // Preserve existing detail data if incoming doesn't have it
        if (!t.details_extracted && prev.details_extracted) {
          merged.line_items = prev.line_items;
          merged.has_denials = prev.has_denials;
          merged.details_extracted = prev.details_extracted;
          merged.detail_url = prev.detail_url;
        }

        // Recompute has_denials from line items
        if (merged.line_items) {
          merged.has_denials = merged.line_items.some((li) => li.approval_status === "Denied");
        }

        byId.set(t.id, merged);
        updated++;
      }
    }
  }

  const merged = Array.from(byId.values()).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
  return { merged, added, updated };
}

function hasLineItemStatusChanges(prev: Transaction, incoming: Transaction): boolean {
  if (!prev.line_items || !incoming.line_items) return false;
  for (let i = 0; i < Math.min(prev.line_items.length, incoming.line_items.length); i++) {
    if (prev.line_items[i].approval_status !== incoming.line_items[i].approval_status) return true;
  }
  return false;
}

function mergeLineItemStatuses(prev: LineItem[], incoming: LineItem[], now: string): LineItem[] {
  return incoming.map((item, i) => {
    const prevItem = prev[i];
    if (!prevItem) return item;

    if (prevItem.approval_status !== item.approval_status) {
      return {
        ...item,
        status_changed_at: now,
        previous_status: prevItem.approval_status,
      };
    }
    // Preserve existing tracking data
    return {
      ...item,
      status_changed_at: prevItem.status_changed_at,
      previous_status: prevItem.previous_status,
    };
  });
}

// ─── Balances ────────────────────────────────────────────────────────

export function loadBalances(path: string): BalanceStore {
  if (!existsSync(path)) {
    return { version: 1, snapshots: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveBalances(path: string, store: BalanceStore): void {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export function addBalanceSnapshot(
  store: BalanceStore,
  snapshot: BalanceSnapshot
): BalanceStore {
  // Don't duplicate if we already have a snapshot for today
  const today = snapshot.date;
  const filtered = store.snapshots.filter((s) => s.date !== today);
  filtered.push(snapshot);
  filtered.sort((a, b) => b.date.localeCompare(a.date));
  return { ...store, snapshots: filtered };
}
