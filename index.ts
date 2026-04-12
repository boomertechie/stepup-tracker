#!/usr/bin/env bun
/**
 * Step Up for Students (EMA) Transaction Tracker
 *
 * Commands:
 *   login              Headless login (credentials via env or stdin, saves session)
 *   discover           Headless portal exploration (map DOM selectors)
 *   extract            Headless extraction (uses saved session)
 *   report [type]      Generate reports: summary, monthly, category, pending
 *   balance            Show latest balance snapshot
 *   --help             Show this help
 *
 * First-time setup:
 *   1. bun run index.ts login       (enter credentials, session is saved)
 *   2. bun run index.ts discover    (explore portal, map page structure)
 *   3. bun run index.ts extract     (pull transaction data)
 *   4. bun run index.ts report      (view summary)
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { loginOnly } from "./src/auth";
import { discover, extract } from "./src/extractor";
import {
  loadTransactions,
  saveTransactions,
  mergeTransactions,
  loadBalances,
  saveBalances,
  addBalanceSnapshot,
} from "./src/storage";
import {
  reportSummary,
  reportMonthly,
  reportCategory,
  reportPending,
  reportDenials,
  reportDashboard,
  exportMarkdown,
} from "./src/report";
import { startServer } from "./src/web";
import { findChrome } from "./src/chrome";
import type { TrackerConfig } from "./src/types";

import { homedir } from "os";

const HOME = homedir();
const STEPUP_DIR = resolve(process.env.STEPUP_DATA_DIR || resolve(HOME, ".stepup-tracker"));
const CONFIG_PATH = resolve(STEPUP_DIR, "config.json");

function loadConfig(): TrackerConfig {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }
  return {
    portal_url: "https://apply.stepupforstudents.org",
    auth_state_path: resolve(STEPUP_DIR, "auth-state.json"),
    browser_path: findChrome(),
    data_dir: STEPUP_DIR,
    headless: true,
  };
}


function showHelp(): void {
  console.log(`
Step Up Tracker - EMA Portal Transaction Tracker

Usage: bun run index.ts <command> [options]

Commands:
  login              Headless login (set STEPUP_USERNAME/STEPUP_PASSWORD or enter at prompt)
  discover           Headless portal exploration (map selectors)
  extract            Pull transactions headlessly (uses saved session)
  serve [port]       Start web dashboard (default: 3210)
  dashboard          Quick CLI dashboard view
  report [type]      Reports: summary, monthly, category, pending, denials
  balance            Show latest balance
  --help, -h         Show this help

Data: ${STEPUP_DIR}
Config: ${CONFIG_PATH}
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  const config = loadConfig();
  const txPath = resolve(config.data_dir, "transactions.json");
  const balPath = resolve(config.data_dir, "balances.json");

  switch (command) {
    case "login": {
      await loginOnly(config);
      break;
    }

    case "discover": {
      await discover(config);
      break;
    }

    case "extract": {
      const existingStore = loadTransactions(txPath);
      const result = await extract(config, undefined, undefined, existingStore.transactions);

      // Merge transactions
      const txStore = loadTransactions(txPath);
      const { merged, added, updated } = mergeTransactions(
        txStore.transactions,
        result.transactions
      );
      saveTransactions(txPath, {
        version: 1,
        last_extract: new Date().toISOString(),
        transactions: merged,
      });
      console.log(`Transactions: ${added} new, ${updated} updated, ${merged.length} total`);

      // Save balance
      if (result.balance) {
        const balStore = loadBalances(balPath);
        const updatedBal = addBalanceSnapshot(balStore, result.balance);
        saveBalances(balPath, updatedBal);
        console.log(`Balance: $${result.balance.available_balance.toFixed(2)} available`);
      }

      // Output JSON to stdout for piping
      console.log(JSON.stringify({ added, updated, total: merged.length }));
      break;
    }

    case "report": {
      const reportType = args[1]?.toLowerCase() || "summary";
      const txStore = loadTransactions(txPath);
      const balStore = loadBalances(balPath);

      switch (reportType) {
        case "summary":
          reportSummary(txStore, balStore);
          break;
        case "monthly":
          reportMonthly(txStore);
          break;
        case "category":
          reportCategory(txStore);
          break;
        case "pending":
          reportPending(txStore);
          break;
        case "denials":
          reportDenials(txStore);
          break;
        default:
          console.error(`Unknown report type: ${reportType}`);
          console.error("Available: summary, monthly, category, pending, denials");
          process.exit(1);
      }
      break;
    }

    case "balance": {
      const balStore = loadBalances(balPath);
      if (balStore.snapshots.length === 0) {
        console.log("No balance data. Run: bun run index.ts extract");
      } else {
        const latest = balStore.snapshots[0];
        console.log(`Balance as of ${latest.date}:`);
        console.log(`  Available: $${latest.available_balance.toFixed(2)}`);
        console.log(`  Total:     $${latest.total_balance.toFixed(2)}`);
      }
      break;
    }

    case "serve": {
      const port = parseInt(args[1] || "3210");
      startServer(txPath, balPath, port);
      break;
    }

    case "dashboard": {
      const txStore = loadTransactions(txPath);
      const balStore = loadBalances(balPath);
      reportDashboard(txStore, balStore);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
