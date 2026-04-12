# Step Up Tracker

A local tool for tracking Florida **Step Up for Students** scholarship reimbursements. Pulls transaction data from the EMA portal (apply.stepupforstudents.org), tracks line-item statuses, denial reasons, and review timelines. Includes a web dashboard for easy viewing.

## What It Does

- Logs into the EMA portal headlessly (handles Azure B2C + MFA)
- Extracts all reimbursement transactions with line-item detail
- Tracks per-item approval status: Submitted, Paid, Denied
- Captures denial reasons for building an evidence trail
- Records status change timestamps for review timeline tracking
- Web dashboard at `http://localhost:3210` for the whole family to view
- In-browser Update button with MFA code entry (no terminal needed after setup)

## Requirements

- [Bun](https://bun.sh) (JavaScript runtime — works on Linux, macOS, and Windows)
- Google Chrome or Chromium installed (auto-detected on all platforms)
- A Step Up for Students EMA portal account

## Quick Start

### Linux / macOS

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone and set up
git clone https://github.com/boomertechie/stepup-tracker.git
cd stepup-tracker
bun install

# Set up credentials
cp .env.example .env
# Edit .env with your EMA username and password
# Note: if your password has special characters (like !), use single quotes:
#   STEPUP_PASSWORD='my-password-with-!'

# First run — logs in, enters MFA code, pulls all data
bun run index.ts extract

# Start the web dashboard
bun run index.ts serve
# Open http://localhost:3210
```

### Windows

```powershell
# Install Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# Clone and set up
git clone https://github.com/boomertechie/stepup-tracker.git
cd stepup-tracker
bun install

# Set up credentials
copy .env.example .env
# Edit .env with Notepad or your editor

# Run
bun run index.ts extract
bun run index.ts serve
```

Chrome is auto-detected from standard install locations on all platforms. If detection fails, set `CHROME_PATH` in your `.env` file.

## Commands

| Command | Description |
|---------|-------------|
| `bun run index.ts login` | Login only (test credentials + MFA) |
| `bun run index.ts extract` | Pull transactions, balances, and line-item details |
| `bun run index.ts serve [port]` | Start web dashboard (default: port 3210) |
| `bun run index.ts dashboard` | Quick CLI summary |
| `bun run index.ts report summary` | Text summary report |
| `bun run index.ts report monthly` | Monthly breakdown |
| `bun run index.ts report pending` | Items awaiting review |
| `bun run index.ts report denials` | Denial report with reasons |
| `bun run index.ts balance` | Current award balance |

## How Authentication Works

The EMA portal uses Azure AD B2C with mandatory MFA (text message code). Every extraction session requires:

1. Username + password (from `.env` file)
2. MFA verification code (texted to your phone)

When running from the **CLI**, you'll be prompted for the code in your terminal.

When running from the **web dashboard**, clicking "Update Data" triggers the login — an input field appears on the page for entering the MFA code.

A browser profile is persisted at `~/.stepup-tracker/browser-profile/` so B2C SSO cookies can sometimes skip the password step (MFA is still required).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STEPUP_USERNAME` | Yes | EMA portal username |
| `STEPUP_PASSWORD` | Yes | EMA portal password |
| `STEPUP_DATA_DIR` | No | Data directory (default: `~/.stepup-tracker`) |
| `STEPUP_PROFILE_DIR` | No | Browser profile dir (default: `~/.stepup-tracker/browser-profile`) |
| `CHROME_PATH` | No | Path to Chrome/Chromium binary (auto-detected) |

## Data Storage

All data is stored locally in `~/.stepup-tracker/` (or `$STEPUP_DATA_DIR`):

- `transactions.json` — All reimbursement transactions with line-item details
- `balances.json` — Award balance snapshots over time
- `config.json` — Generated on first run with auto-detected paths

No data is sent anywhere. Everything stays on your machine.

## Web Dashboard

The dashboard shows:

- **Balance cards** — Award balance, paid amount, awaiting review, denied amount, remaining estimate
- **Budget progress bar** — Visual spend tracking
- **On-hold items** — Action required, with day count and expiry warnings
- **Denial report** — Each denied item with reason and review time
- **Pending items** — Submitted reimbursements waiting for review
- **Vendor breakdown** — Top vendors by spend
- **All transactions** — Full table with status badges and line-item counts

The "Update Data" button triggers a fresh extraction from the portal. You'll enter your MFA code right on the page. There's a 5-minute cooldown between updates.

## Running as a Service

To keep the dashboard running persistently:

### Linux (systemd)

```ini
# /etc/systemd/system/stepup-tracker.service
[Unit]
Description=Step Up Scholarship Tracker
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/stepup-tracker
EnvironmentFile=/path/to/stepup-tracker/.env
ExecStart=/home/your-username/.bun/bin/bun run index.ts serve 3210
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp stepup-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stepup-tracker
```

### macOS (launchd)

```bash
# Quick background start
nohup bun run index.ts serve 3210 > /tmp/stepup-tracker.log 2>&1 &
```

Or create a `~/Library/LaunchAgents/com.stepup-tracker.plist` for auto-start at login.

### Windows

```powershell
# Quick background start (PowerShell)
Start-Process -NoNewWindow bun -ArgumentList "run index.ts serve 3210"
```

Or use [NSSM](https://nssm.cc/) to install as a Windows service.

## Technical Notes

- The EMA portal is a **Blazor/.NET** SPA that uses SignalR WebSocket for rendering
- Navigation must use **click-based SPA routing** (not `page.goto`) to preserve the MSAL session
- MSAL tokens live in sessionStorage and don't persist across browser launches
- The reimbursement table uses a **Radzen grid** (`table.rz-grid-table`)
- Detail pages are navigated via the "Details" button per row, then "Back" to return
- Denial reasons are extracted from `Reason for Denial:` and `Comments:` text patterns in the detail page body
- Transaction-level "Complete" status can be misleading — a Complete transaction may contain denied items. Line-item status (Paid/Denied/Submitted) is the true metric.

## License

MIT
