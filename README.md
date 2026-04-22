# Robinhood Portfolio Tracker

A Flask app for tracking a Robinhood portfolio using your activity report export. It imports buys, cash transfers, dividends, interest, stock splits, and ACAT transfers, then compares your live portfolio against benchmark strategies such as SPY.

This project is designed for personal portfolio analysis while still being easy to open source. Local portfolio data is stored in CSV files, and the recommended `.gitignore` excludes those files by default.

## Features

- Import a Robinhood activity CSV and rebuild the portfolio from scratch
- Track stock purchases, cash balance, dividends, interest, and fees
- Handle ACAT incoming transfers and stock split events
- Show portfolio value, deposited capital, and current cash balance
- Compare portfolio performance against SPY and other benchmarks
- Treat benchmark strategies as fully invested on each deposit or transfer date
- Store local state in simple CSV files

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

When you upload a new Robinhood activity report, the app clears previous generated portfolio state and rebuilds from the new file.

That fresh import resets local state for:

- `stocks_data.csv`
- `cash_transactions.csv`
- `splits.csv`
- `pending_transfers.csv`

This avoids duplicate imports and keeps the dashboard aligned with the latest full report.

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

### 2. Create a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the app

```bash
python app.py
```

Then open:

```text
http://127.0.0.1:5000
```

## Usage

1. Open the app in your browser.
2. Upload your Robinhood activity report CSV.
3. Review portfolio value, cash, and benchmark charts.
4. Re-upload a newer full report whenever you want to refresh the portfolio.

## Project Files

- [app.py](/Users/gurudattapatil/Documents/GitHub/Stocks/app.py): Flask server and import logic
- [templates/index.html](/Users/gurudattapatil/Documents/GitHub/Stocks/templates/index.html): Main UI
- [requirements.txt](/Users/gurudattapatil/Documents/GitHub/Stocks/requirements.txt): Python dependencies
- [sample.csv](/Users/gurudattapatil/Documents/GitHub/Stocks/sample.csv): Example CSV kept in the repo

Generated local files such as portfolio CSVs, caches, and virtual environments should stay untracked.

## Open Source / Privacy Notes

If you publish this repository, do not commit your personal Robinhood exports or generated portfolio state.

The included `.gitignore` excludes common sensitive and generated files, including:

- Robinhood report exports
- Local portfolio CSV state
- Benchmark preferences
- Cache files
- Virtual environments

Before pushing to a public repo, verify that no personal CSV or account-derived files are staged.

## Notes

- This project is not affiliated with Robinhood.
- Market data is fetched from public finance libraries and services used by the app.
- If numbers look wrong after an import, re-export a full history report from account start to current date and upload it again.

## License

Add your preferred license before publishing publicly.
