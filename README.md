# Robinhood Portfolio Tracker

A Node.js app for tracking a Robinhood portfolio using your activity report export. It imports buys, cash transfers, dividends, interest, stock splits, and ACAT transfers, then compares your live portfolio against benchmark strategies such as SPY.

The UI runs entirely in the browser and stores imported transactions locally in IndexedDB. The Node server is only used for market price lookups and caching.

## Features

- Import a Robinhood activity CSV and rebuild the portfolio from scratch
- Track stock purchases, cash balance, dividends, interest, and fees
- Handle ACAT incoming transfers and stock split events
- Show portfolio value, deposited capital, and current cash balance
- Compare portfolio performance against SPY and other benchmarks
- Treat benchmark strategies as fully invested on each deposit or transfer date
- Store imported transactions locally in the browser

## Robinhood Export

Get your activity report here:

[Robinhood Activity Reports](https://robinhood.com/account/reports-statements/activity-reports)

For the most accurate import, export the report from your account start date through the current date.

Why this matters:

- Cash balance depends on the full transfer and fee history
- ACAT transfers need the original arrival date to benchmark correctly
- Stock splits need the full history to reconstruct holdings accurately
- Partial exports can make deposits, holdings, and benchmark comparisons look wrong

## How Imports Work

When you upload a new Robinhood activity report, the app clears the previously imported browser-side transaction data and rebuilds the portfolio from the new file.

That avoids duplicate imports and keeps the dashboard aligned with the latest full report.

## Benchmark Logic

The benchmark comparison follows a simple rule:

- Bank transfers are invested into the benchmark on the day they arrive
- Incoming ACAT stock value is treated as if it were sold on arrival and invested into the benchmark the same day
- The benchmark keeps no idle cash

This makes the benchmark line a fully invested comparison against your real portfolio.

## Setup

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd Stocks
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## Usage

1. Open the app in your browser.
2. Upload your Robinhood activity report CSV.
3. Review portfolio value, cash, and benchmark charts.
4. Re-upload a newer full report whenever you want to refresh the portfolio.

## Project Files

- [server.js](/Users/gurudattapatil/Documents/GitHub/Stocks/server.js): Node server for current and historical price lookups
- [public/index.html](/Users/gurudattapatil/Documents/GitHub/Stocks/public/index.html): Main UI shell
- [package.json](/Users/gurudattapatil/Documents/GitHub/Stocks/package.json): Node scripts and dependencies
- [sample.csv](/Users/gurudattapatil/Documents/GitHub/Stocks/sample.csv): Example CSV kept in the repo

Generated local files such as caches, browser storage exports, and `node_modules` should stay untracked.

## Open Source / Privacy Notes

If you publish this repository, do not commit your personal Robinhood exports or generated portfolio state.

The included `.gitignore` excludes common sensitive and generated files, including:

- Robinhood report exports
- Local browser-stored portfolio state and caches
- Benchmark preferences
- Cache files
- Node dependencies

Before pushing to a public repo, verify that no personal CSV or account-derived files are staged.

## Notes

- This project is not affiliated with Robinhood.
- Market data is fetched from Yahoo Finance through the Node server.
- If numbers look wrong after an import, re-export a full history report from account start to current date and upload it again.

## License

Add your preferred license before publishing publicly.
