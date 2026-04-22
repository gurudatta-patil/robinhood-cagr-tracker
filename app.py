from flask import Flask, render_template, request, jsonify, redirect, url_for
import pandas as pd
import requests
import os
import csv
import io
from datetime import datetime, date, timedelta
import json
import math
import yfinance as yf
import plotly.graph_objs as go
import plotly.utils

app = Flask(__name__)

# CSV file to store stock data
CSV_FILE = 'stocks_data.csv'
SPY_CACHE_FILE = 'spy_cache.csv'
CASH_FILE = 'cash_transactions.csv'
SPLITS_FILE = 'splits.csv'
PENDING_TRANSFERS_FILE = 'pending_transfers.csv'
BENCHMARKS_FILE = 'benchmarks.json'

def load_stocks_data():
    """Load stocks data from CSV file"""
    if os.path.exists(CSV_FILE):
        try:
            df = pd.read_csv(CSV_FILE)
            return df.to_dict('records')
        except:
            return []
    return []

def save_stocks_data(stocks):
    """Save stocks data to CSV file"""
    df = pd.DataFrame(stocks)
    df.to_csv(CSV_FILE, index=False)

def load_cash_data():
    """Load cash transactions from CSV file"""
    if os.path.exists(CASH_FILE):
        try:
            df = pd.read_csv(CASH_FILE)
            return df.to_dict('records')
        except:
            return []
    return []

def save_cash_data(transactions):
    """Save cash transactions to CSV file"""
    df = pd.DataFrame(transactions)
    df.to_csv(CASH_FILE, index=False)

def load_splits():
    """Load split history: [{symbol, split_date, ratio}]"""
    if os.path.exists(SPLITS_FILE):
        try:
            df = pd.read_csv(SPLITS_FILE)
            return df.to_dict('records')
        except:
            return []
    return []

def record_split(symbol, split_date_str, ratio):
    """Add a split to splits.csv if not already there"""
    splits = load_splits()
    for s in splits:
        if s['symbol'] == symbol and s['split_date'] == split_date_str:
            return  # already recorded
    splits.append({'symbol': symbol, 'split_date': split_date_str, 'ratio': ratio})
    pd.DataFrame(splits).to_csv(SPLITS_FILE, index=False)

def get_cumulative_split_factor(symbol, after_date_str):
    """Return the total split multiplier for symbol for all splits that happened AFTER after_date_str."""
    splits = load_splits()
    factor = 1
    for s in splits:
        if s['symbol'] == symbol and s['split_date'] > after_date_str:
            factor *= int(s['ratio'])
    return factor

def load_pending_transfers():
    """Load pending transfer entries needing cost basis"""
    if os.path.exists(PENDING_TRANSFERS_FILE):
        try:
            df = pd.read_csv(PENDING_TRANSFERS_FILE)
            return df.to_dict('records')
        except:
            return []
    return []

def save_pending_transfers(transfers):
    """Save pending transfers to CSV"""
    pd.DataFrame(transfers).to_csv(PENDING_TRANSFERS_FILE, index=False)

def stock_uses_cash(stock):
    """Return whether a position should reduce cash when computing balances."""
    return stock.get('source', 'buy') != 'transfer'

def load_benchmarks():
    """Load benchmark tickers list. SPY is always first."""
    if os.path.exists(BENCHMARKS_FILE):
        try:
            with open(BENCHMARKS_FILE) as f:
                tickers = json.load(f)
            if 'SPY' not in tickers:
                tickers.insert(0, 'SPY')
            return tickers
        except:
            pass
    return ['SPY']

def save_benchmarks(tickers):
    if 'SPY' not in tickers:
        tickers = ['SPY'] + tickers
    with open(BENCHMARKS_FILE, 'w') as f:
        json.dump(tickers, f)

def fetch_ticker_history(symbol, start_date, end_date):
    """Fetch full price history for a ticker, returns date→price dict."""
    try:
        hist = yf.Ticker(symbol).history(start=start_date, end=end_date + timedelta(days=1))
        
        # Heuristic retroactive split adjustment for missing yfinance splits
        if not hist.empty:
            closes = hist['Close'].values
            for i in range(len(closes) - 1, 0, -1):
                prev = closes[i-1]
                curr = closes[i]
                if curr > 0 and prev / curr > 1.5:
                    ratio = round(prev / curr)
                    closes[:i] = closes[:i] / ratio
            hist['Close'] = closes

        hist_naive = hist.copy()
        hist_naive.index = (hist_naive.index.tz_localize(None)
                            if hist_naive.index.tz is None
                            else hist_naive.index.tz_convert(None))
        return {idx.date(): float(row['Close']) for idx, row in hist_naive.iterrows()}
    except Exception as e:
        print(f"Error fetching history for {symbol}: {e}")
        return {}

def parse_amount(s):
    """Parse Robinhood amount: $1,234.56 or ($1,234.56) for negative"""
    if not s or str(s).strip() == '':
        return 0.0
    s = str(s).strip()
    negative = s.startswith('(') and s.endswith(')')
    s = s.replace('(', '').replace(')', '').replace('$', '').replace(',', '')
    try:
        val = float(s)
        return -val if negative else val
    except:
        return 0.0

def parse_robinhood_csv(content):
    """Parse Robinhood activity CSV. Returns (stock_trades, cash_transactions, split_events, acati_transfers)."""
    stock_trades = []
    cash_transactions = []
    split_events = []
    acati_transfers = []  # ACATI entries with symbol+quantity (need cost basis)

    reader = csv.reader(io.StringIO(content))
    rows = list(reader)

    # Find header row
    header_idx = None
    for i, row in enumerate(rows):
        if row and row[0].strip().strip('"') == 'Activity Date':
            header_idx = i
            break

    if header_idx is None:
        return stock_trades, cash_transactions

    for row in rows[header_idx + 1:]:
        if not row or not row[0].strip():
            continue
        if len(row) < 9:
            continue
        try:
            activity_date = row[0].strip().strip('"')
            instrument = row[3].strip().strip('"')
            description = row[4].strip().strip('"').replace('\n', ' ')
            trans_code = row[5].strip().strip('"')
            quantity_str = row[6].strip().strip('"')
            price_str = row[7].strip().strip('"')
            amount_str = row[8].strip().strip('"')

            if not trans_code or not activity_date:
                continue

            try:
                dt = datetime.strptime(activity_date, '%m/%d/%Y')
                date_str = dt.strftime('%Y-%m-%d')
            except:
                continue

            amount = parse_amount(amount_str)

            if trans_code == 'Buy':
                quantity = float(quantity_str) if quantity_str else 0
                price = parse_amount(price_str)
                if instrument and quantity > 0 and price > 0:
                    stock_trades.append({
                        'symbol': instrument,
                        'quantity': quantity,
                        'buy_price': price,
                        'buy_date': date_str,
                        'source': 'buy',
                        'date_added': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    })
            elif trans_code == 'SPL':
                # Stock split: quantity column holds the new shares granted
                if instrument:
                    spl_shares = float(quantity_str) if quantity_str else 0
                    split_events.append({
                        'symbol': instrument,
                        'date': date_str,
                        'shares_added': spl_shares
                    })
            elif trans_code == 'ACATI':
                # Transfer in from another broker
                if instrument and quantity_str:
                    try:
                        qty = float(quantity_str)
                        if qty > 0:
                            acati_transfers.append({
                                'symbol': instrument,
                                'quantity': qty,
                                'transfer_date': date_str,
                                'description': description[:200]
                            })
                    except:
                        pass
                elif amount != 0:
                    # Residual cash from ACAT
                    cash_transactions.append({
                        'date': date_str,
                        'trans_code': 'ACATI',
                        'amount': amount,
                        'description': description[:200]
                    })
            elif trans_code in ('RTP', 'ACH', 'JNLE', 'CDIV', 'MISC', 'SLIP', 'INT', 'GDBP',
                                'XENT_CC', 'ABIP', 'ACATI', 'T/A', 'REC', 'GMPC', 'DTAX', 'GOLD'):
                cash_transactions.append({
                    'date': date_str,
                    'trans_code': trans_code,
                    'amount': amount,
                    'description': description[:200]
                })
        except Exception as e:
            print(f"Error parsing row: {row}, error: {e}")
            continue

    return stock_trades, cash_transactions, split_events, acati_transfers

def load_spy_cache():
    """Load SPY cache from CSV file"""
    if os.path.exists(SPY_CACHE_FILE):
        try:
            df = pd.read_csv(SPY_CACHE_FILE)
            df['date'] = pd.to_datetime(df['date']).dt.date
            return df.set_index('date')['close'].to_dict()
        except:
            return {}
    return {}

def save_spy_cache(spy_cache):
    """Save SPY cache to CSV file"""
    if spy_cache:
        df = pd.DataFrame([
            {'date': date_obj.strftime('%Y-%m-%d'), 'close': price}
            for date_obj, price in spy_cache.items()
        ])
        df.to_csv(SPY_CACHE_FILE, index=False)

def update_spy_cache_daily():
    """Update SPY cache with latest data if needed"""
    try:
        spy_cache = load_spy_cache()
        today = date.today()
        yesterday = today - timedelta(days=1)
        
        # Check if we need to update (if today's or yesterday's data is missing)
        needs_update = today not in spy_cache or yesterday not in spy_cache
        
        if needs_update:
            print("Updating SPY cache with latest data...")
            spy_ticker = yf.Ticker('SPY')
            # Get last 5 days to ensure we have recent data
            spy_data = spy_ticker.history(period="5d")
            
            if not spy_data.empty:
                spy_data_naive = spy_data.copy()
                spy_data_naive.index = spy_data_naive.index.tz_localize(None) if spy_data_naive.index.tz is None else spy_data_naive.index.tz_convert(None)
                
                new_entries = 0
                for date_idx in spy_data_naive.index:
                    date_obj = date_idx.date()
                    if date_obj not in spy_cache:
                        spy_cache[date_obj] = float(spy_data_naive.loc[date_idx, 'Close'])
                        new_entries += 1
                
                if new_entries > 0:
                    save_spy_cache(spy_cache)
                    print(f"Added {new_entries} new SPY data points to cache")
                else:
                    print("SPY cache is up to date")
            else:
                print("Could not fetch latest SPY data")
        else:
            print("SPY cache is current")
            
    except Exception as e:
        print(f"Error updating SPY cache: {e}")

def get_spy_data_with_cache(start_date, end_date):
    """Get SPY data with caching"""
    # Load existing cache
    spy_cache = load_spy_cache()
    
    # Convert string dates to date objects for comparison
    start_date_obj = datetime.strptime(start_date, '%Y-%m-%d').date()
    end_date_obj = datetime.strptime(end_date, '%Y-%m-%d').date()
    
    # Check what dates we need to fetch
    missing_dates = []
    current_date = start_date_obj
    
    while current_date <= end_date_obj:
        if current_date not in spy_cache:
            missing_dates.append(current_date)
        current_date += timedelta(days=1)
    
    # Fetch missing data if needed
    if missing_dates:
        print(f"Fetching SPY data for {len(missing_dates)} missing dates...")
        try:
            spy_ticker = yf.Ticker('SPY')
            # Fetch a bit more data to ensure we get all needed dates
            fetch_start = min(missing_dates) - timedelta(days=5)
            fetch_end = max(missing_dates) + timedelta(days=5)
            
            spy_data = spy_ticker.history(start=fetch_start, end=fetch_end)
            
            if not spy_data.empty:
                # Add new data to cache
                spy_data_naive = spy_data.copy()
                spy_data_naive.index = spy_data_naive.index.tz_localize(None) if spy_data_naive.index.tz is None else spy_data_naive.index.tz_convert(None)
                
                for date_idx in spy_data_naive.index:
                    date_obj = date_idx.date()
                    spy_cache[date_obj] = float(spy_data_naive.loc[date_idx, 'Close'])
                
                # Save updated cache
                save_spy_cache(spy_cache)
                print(f"Updated SPY cache with {len(spy_data_naive)} new data points")
        except Exception as e:
            print(f"Error fetching SPY data: {e}")
    
    return spy_cache

def get_current_stock_price(symbol):
    """Fetch current stock price using yfinance"""
    try:
        # First try yfinance
        ticker = yf.Ticker(symbol)
        data = ticker.history(period="1d")
        if not data.empty:
            return float(data['Close'].iloc[-1])
        
        # Fallback to Alpha Vantage
        api_key = "NHN4X37YGG6VCHG9"
        url = f"https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={symbol}&apikey={api_key}"
        
        response = requests.get(url, timeout=10)
        data = response.json()
        
        if "Global Quote" in data:
            price = float(data["Global Quote"]["05. price"])
            return price
        else:
            # Fallback: Return a mock price for demo purposes
            return 150.0 + hash(symbol) % 100
    except Exception as e:
        print(f"Error fetching price for {symbol}: {e}")
        # Return a mock price for demo purposes
        return 150.0 + hash(symbol) % 100

def calculate_cagr(initial_value, final_value, years):
    """Calculate Compound Annual Growth Rate"""
    if years <= 0 or initial_value <= 0:
        return 0
    try:
        cagr = (pow(final_value / initial_value, 1/years) - 1) * 100
        return round(cagr, 2)
    except:
        return 0

def calculate_days_between(buy_date_str):
    """Calculate days between buy date and today"""
    try:
        buy_date = datetime.strptime(buy_date_str, '%Y-%m-%d').date()
        today = date.today()
        return (today - buy_date).days
    except:
        return 0

def consolidate_stocks_by_symbol(stocks):
    """Consolidate stocks with the same symbol into a single entry with weighted averages"""
    consolidated = {}
    
    for stock in stocks:
        symbol = stock['symbol']
        quantity = stock['quantity']
        buy_price = stock['buy_price']
        buy_date = stock['buy_date']
        
        if symbol not in consolidated:
            consolidated[symbol] = {
                'symbol': symbol,
                'total_quantity': quantity,
                'total_investment': quantity * buy_price,
                'weighted_avg_price': buy_price,
                'earliest_date': buy_date,
                'latest_date': buy_date,
                'purchases': [stock]
            }
        else:
            # Add to existing position
            existing = consolidated[symbol]
            new_investment = quantity * buy_price
            
            existing['total_quantity'] += quantity
            existing['total_investment'] += new_investment
            existing['weighted_avg_price'] = existing['total_investment'] / existing['total_quantity']
            
            # Track date range
            if buy_date < existing['earliest_date']:
                existing['earliest_date'] = buy_date
            if buy_date > existing['latest_date']:
                existing['latest_date'] = buy_date
                
            existing['purchases'].append(stock)
    
    # Convert back to list format for compatibility
    result = []
    for symbol_data in consolidated.values():
        result.append({
            'symbol': symbol_data['symbol'],
            'quantity': symbol_data['total_quantity'],
            'buy_price': symbol_data['weighted_avg_price'],
            'buy_date': symbol_data['earliest_date'],
            'total_investment': symbol_data['total_investment'],
            'purchase_count': len(symbol_data['purchases']),
            'date_range': f"{symbol_data['earliest_date']} to {symbol_data['latest_date']}" if symbol_data['earliest_date'] != symbol_data['latest_date'] else symbol_data['earliest_date']
        })
    
    return result

def get_unique_symbols(stocks):
    """Get unique symbols from stocks list for chart tabs"""
    symbols = set()
    for stock in stocks:
        symbols.add(stock['symbol'])
    return sorted(list(symbols))

def calculate_portfolio_cagr(raw_stocks):
    """Calculate true portfolio CAGR based on weighted average of all trades"""
    if not raw_stocks:
        return 0
    
    total_weighted_investment = 0
    total_weighted_days = 0
    total_current_value = 0
    
    for stock in raw_stocks:
        current_price = get_current_stock_price(stock['symbol'])
        investment = stock['quantity'] * stock['buy_price']
        current_value = stock['quantity'] * current_price
        days = calculate_days_between(stock['buy_date'])
        
        # Weight the days by investment amount
        total_weighted_investment += investment
        total_weighted_days += days * investment
        total_current_value += current_value
    
    if total_weighted_investment == 0:
        return 0
    
    # Calculate weighted average holding period
    avg_days = total_weighted_days / total_weighted_investment
    avg_years = avg_days / 365.25
    
    # Calculate portfolio CAGR
    if avg_years > 0 and total_weighted_investment > 0:
        portfolio_cagr = calculate_cagr(total_weighted_investment, total_current_value, avg_years)
        return portfolio_cagr
    
    return 0

@app.route('/')
def index():
    """Main page"""
    # Update SPY cache daily
    update_spy_cache_daily()

    raw_stocks = load_stocks_data()
    cash_transactions = load_cash_data()

    # Get consolidated stocks for display
    consolidated_stocks = consolidate_stocks_by_symbol(raw_stocks)

    # Calculate current values and CAGR for each consolidated position
    for stock in consolidated_stocks:
        current_price = get_current_stock_price(stock['symbol'])
        stock['current_price'] = current_price
        stock['current_value'] = stock['quantity'] * current_price
        stock['profit_loss'] = stock['current_value'] - stock['total_investment']
        stock['profit_loss_percent'] = round((stock['profit_loss'] / stock['total_investment']) * 100, 2) if stock['total_investment'] > 0 else 0

        days = calculate_days_between(stock['buy_date'])
        years = days / 365.25
        stock['cagr'] = calculate_cagr(stock['total_investment'], stock['current_value'], years)
        stock['days_held'] = days

    # Calculate true portfolio CAGR
    portfolio_cagr = calculate_portfolio_cagr(raw_stocks)

    # Get unique symbols for chart tabs
    unique_symbols = get_unique_symbols(raw_stocks)

    # Cash calculations
    cash_in = sum(float(tx['amount']) for tx in cash_transactions)
    stock_costs = sum(
        float(s['quantity']) * float(s['buy_price'])
        for s in raw_stocks
        if stock_uses_cash(s)
    )
    cash_balance = cash_in - stock_costs
    total_deposited = sum(float(tx['amount']) for tx in cash_transactions if tx['trans_code'] in ('RTP', 'ACH', 'JNLE'))

    return render_template('index.html', stocks=consolidated_stocks, unique_symbols=unique_symbols,
                           raw_stocks=raw_stocks, portfolio_cagr=portfolio_cagr,
                           cash_balance=cash_balance, total_deposited=total_deposited,
                           has_cash_data=len(cash_transactions) > 0)

@app.route('/add_stock', methods=['POST'])
def add_stock():
    """Add a new stock to the portfolio"""
    try:
        symbol = request.form['symbol'].upper()
        quantity = float(request.form['quantity'])
        buy_price = float(request.form['buy_price'])
        buy_date = request.form['buy_date']

        # Auto-apply any splits that happened AFTER the buy_date
        split_factor = get_cumulative_split_factor(symbol, buy_date)
        if split_factor > 1:
            quantity = round(quantity * split_factor, 6)
            buy_price = round(buy_price / split_factor, 4)

        stocks = load_stocks_data()
        stocks.append({
            'symbol': symbol,
            'quantity': quantity,
            'buy_price': buy_price,
            'buy_date': buy_date,
            'source': 'buy',
            'date_added': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
        save_stocks_data(stocks)
        return redirect(url_for('index'))
    except Exception as e:
        return f"Error adding stock: {e}", 400

@app.route('/delete_stock/<int:index>')
def delete_stock(index):
    """Delete a stock from the portfolio"""
    try:
        stocks = load_stocks_data()
        if 0 <= index < len(stocks):
            stocks.pop(index)
            save_stocks_data(stocks)
        return redirect(url_for('index'))
    except Exception as e:
        return f"Error deleting stock: {e}", 400

@app.route('/delete_all_symbol/<symbol>')
def delete_all_symbol(symbol):
    """Delete all entries for a specific symbol"""
    try:
        stocks = load_stocks_data()
        stocks = [stock for stock in stocks if stock['symbol'] != symbol.upper()]
        save_stocks_data(stocks)
        return redirect(url_for('index'))
    except Exception as e:
        return f"Error deleting stocks: {e}", 400

@app.route('/upload_csv', methods=['POST'])
def upload_csv():
    """Parse and import a Robinhood activity CSV"""
    try:
        if 'file' not in request.files:
            return jsonify({'status': 'error', 'message': 'No file provided'}), 400

        file = request.files['file']
        if not file.filename.lower().endswith('.csv'):
            return jsonify({'status': 'error', 'message': 'File must be a CSV'}), 400

        content = file.read().decode('utf-8', errors='replace')
        stock_trades, cash_transactions, split_events, acati_transfers = parse_robinhood_csv(content)

        if not stock_trades and not cash_transactions and not split_events and not acati_transfers:
            return jsonify({'status': 'error', 'message': 'No recognizable transactions found. Make sure it is a Robinhood activity CSV.'}), 400

        # Clear previous data on new upload
        existing_stocks = []
        if os.path.exists(CSV_FILE):
            os.remove(CSV_FILE)
        if os.path.exists(CASH_FILE):
            os.remove(CASH_FILE)
        if os.path.exists(SPLITS_FILE):
            os.remove(SPLITS_FILE)
        if os.path.exists(PENDING_TRANSFERS_FILE):
            os.remove(PENDING_TRANSFERS_FILE)

        # ── Regular Buy trades ──
        new_stocks = list(stock_trades)

        # ── ACATI transfers: auto-fetch historical price, apply post-transfer splits ──
        acati_added = 0
        acati_skipped = 0
        for t in acati_transfers:
            sym = t['symbol']
            orig_qty = float(t['quantity'])
            transfer_date = t['transfer_date']

            # Apply any splits that happened AFTER the transfer date
            split_factor = get_cumulative_split_factor(sym, transfer_date)
            adjusted_qty = round(orig_qty * split_factor, 6)

            # Dedup: skip if (symbol, date, ~quantity) already in stocks
            already = any(
                s['symbol'] == sym and s['buy_date'] == transfer_date
                and abs(float(s['quantity']) - adjusted_qty) < 0.001
                for s in existing_stocks
            )
            if already:
                acati_skipped += 1
                continue

            # Fetch closing price on transfer date (pre-split price, then divide by split factor)
            raw_price = get_stock_price_for_date(sym, transfer_date)
            adjusted_price = round(raw_price / split_factor, 4) if split_factor > 1 else round(raw_price, 4)

            entry = {
                'symbol': sym,
                'quantity': adjusted_qty,
                'buy_price': adjusted_price,
                'buy_date': transfer_date,
                'source': 'transfer',
                'date_added': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            }
            new_stocks.append(entry)
            acati_added += 1

        # ── Always save the fresh data ──
        save_stocks_data(existing_stocks + new_stocks)

        # ── Cash transactions ──
        existing_cash = load_cash_data()
        
        # We do not use existing_cash_keys anymore as previous files are wiped
        new_cash = list(cash_transactions)
        
        # ── Always save the fresh data ──
        save_cash_data(existing_cash + new_cash)

        # ── Apply stock splits ──
        splits_applied = []
        if split_events and new_stocks:
            df = pd.read_csv(CSV_FILE)
            for spl in split_events:
                sym = spl['symbol']
                split_date = spl['date']
                spl_shares = spl['shares_added']
                pre = df[(df['symbol'] == sym) & (df['buy_date'] < split_date)]
                pre_total = pre['quantity'].sum()
                if pre_total <= 0:
                    continue
                ratio = round(1 + spl_shares / pre_total)
                if ratio < 2:
                    continue
                mask = (df['symbol'] == sym) & (df['buy_date'] < split_date)
                df.loc[mask, 'quantity'] = df.loc[mask, 'quantity'] * ratio
                df.loc[mask, 'buy_price'] = df.loc[mask, 'buy_price'] / ratio
                df.to_csv(CSV_FILE, index=False)
                record_split(sym, split_date, ratio)
                splits_applied.append(f'{sym} {ratio}:1 on {split_date}')

        buy_added = len(new_stocks) - acati_added
        return jsonify({
            'status': 'success',
            'new_stocks': buy_added,
            'acati_added': acati_added,
            'acati_skipped': acati_skipped,
            'new_cash_transactions': len(new_cash),
            'skipped_stocks': len(stock_trades) - buy_added,
            'splits_applied': splits_applied
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/view_details/<symbol>')
def view_details(symbol):
    """View detailed breakdown for a consolidated symbol"""
    try:
        stocks = load_stocks_data()
        symbol_stocks = [stock for stock in stocks if stock['symbol'] == symbol.upper()]
        
        detailed_data = []
        for stock in symbol_stocks:
            current_price = get_current_stock_price(stock['symbol'])
            current_value = stock['quantity'] * current_price
            total_investment = stock['quantity'] * stock['buy_price']
            profit_loss = current_value - total_investment
            
            detailed_data.append({
                'quantity': stock['quantity'],
                'buy_price': stock['buy_price'],
                'buy_date': stock['buy_date'],
                'current_price': current_price,
                'current_value': current_value,
                'total_investment': total_investment,
                'profit_loss': profit_loss,
                'profit_loss_percent': (profit_loss / total_investment * 100) if total_investment > 0 else 0
            })
        
        return jsonify({
            'symbol': symbol.upper(),
            'details': detailed_data
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/refresh_prices')
def refresh_prices():
    """API endpoint to refresh all stock prices"""
    try:
        stocks = load_stocks_data()
        
        for stock in stocks:
            current_price = get_current_stock_price(stock['symbol'])
            stock['current_price'] = current_price
        
        return jsonify({'status': 'success', 'message': 'Prices refreshed'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/portfolio_data')
def portfolio_data():
    """API endpoint to get portfolio data for charts"""
    try:
        raw_stocks = load_stocks_data()
        cash_transactions = load_cash_data()
        consolidated_stocks = consolidate_stocks_by_symbol(raw_stocks)

        # Portfolio allocation data
        allocation_data = []
        total_value = 0

        for stock in consolidated_stocks:
            current_price = get_current_stock_price(stock['symbol'])
            current_value = stock['quantity'] * current_price
            total_value += current_value

            allocation_data.append({
                'symbol': stock['symbol'],
                'value': current_value,
                'quantity': stock['quantity'],
                'purchase_count': stock.get('purchase_count', 1)
            })

        # Add cash as a slice if meaningful
        cash_in = sum(float(tx['amount']) for tx in cash_transactions)
        stock_costs = sum(
            float(s['quantity']) * float(s['buy_price'])
            for s in raw_stocks
            if stock_uses_cash(s)
        )
        cash_balance = cash_in - stock_costs
        if cash_balance > 0:
            total_value += cash_balance
            allocation_data.append({
                'symbol': 'CASH',
                'value': cash_balance,
                'quantity': 1,
                'purchase_count': 0
            })

        # Calculate percentages
        for item in allocation_data:
            item['percentage'] = (item['value'] / total_value * 100) if total_value > 0 else 0

        return jsonify({
            'allocation': allocation_data,
            'total_value': total_value
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/performance_data')
def performance_data():
    """API endpoint to get performance data for charts"""
    try:
        raw_stocks = load_stocks_data()
        consolidated_stocks = consolidate_stocks_by_symbol(raw_stocks)
        
        performance_data = []
        
        for stock in consolidated_stocks:
            current_price = get_current_stock_price(stock['symbol'])
            current_value = stock['quantity'] * current_price
            total_investment = stock['total_investment']
            profit_loss = current_value - total_investment
            profit_loss_percent = (profit_loss / total_investment * 100) if total_investment > 0 else 0
            
            days = calculate_days_between(stock['buy_date'])
            years = days / 365.25
            cagr = calculate_cagr(total_investment, current_value, years)
            
            performance_data.append({
                'symbol': stock['symbol'],
                'investment': total_investment,
                'current_value': current_value,
                'profit_loss': profit_loss,
                'profit_loss_percent': profit_loss_percent,
                'cagr': cagr,
                'days_held': days,
                'purchase_count': stock.get('purchase_count', 1)
            })
        
        return jsonify(performance_data)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/historical_data/<symbol>')
def historical_data(symbol):
    """API endpoint to get historical price data for a stock"""
    try:
        ticker = yf.Ticker(symbol)
        # Get 1 year of historical data
        hist = ticker.history(period="1y")

        dates = [date.strftime('%Y-%m-%d') for date in hist.index]
        prices = hist['Close'].tolist()

        return jsonify({
            'dates': dates,
            'prices': prices,
            'symbol': symbol
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/benchmarks', methods=['GET'])
def get_benchmarks():
    return jsonify({'benchmarks': load_benchmarks()})

@app.route('/api/benchmarks/add', methods=['POST'])
def add_benchmark():
    ticker = request.json.get('ticker', '').upper().strip()
    if not ticker:
        return jsonify({'status': 'error', 'message': 'No ticker provided'}), 400
    # Quick validate — try to fetch a tiny bit of data
    try:
        info = yf.Ticker(ticker).history(period='5d')
        if info.empty:
            return jsonify({'status': 'error', 'message': f'No data found for {ticker}'}), 400
    except:
        return jsonify({'status': 'error', 'message': f'Could not validate {ticker}'}), 400
    benchmarks = load_benchmarks()
    if ticker not in benchmarks:
        benchmarks.append(ticker)
        save_benchmarks(benchmarks)
    return jsonify({'status': 'success', 'benchmarks': benchmarks})

@app.route('/api/benchmarks/remove/<ticker>', methods=['POST'])
def remove_benchmark(ticker):
    ticker = ticker.upper()
    if ticker == 'SPY':
        return jsonify({'status': 'error', 'message': 'SPY cannot be removed'}), 400
    benchmarks = load_benchmarks()
    benchmarks = [b for b in benchmarks if b != ticker]
    save_benchmarks(benchmarks)
    return jsonify({'status': 'success', 'benchmarks': benchmarks})

@app.route('/api/networth_data')
def networth_data():
    """Portfolio networth vs configurable benchmarks using cash deposit dates."""
    try:
        raw_stocks = load_stocks_data()
        cash_transactions = load_cash_data()
        benchmark_tickers = load_benchmarks()  # e.g. ['SPY', 'QQQ']

        empty = {'dates': [], 'portfolio_values': [], 'total_investments': [],
                 'benchmarks': {t: [] for t in benchmark_tickers}}
        if not raw_stocks and not cash_transactions:
            return jsonify(empty)

        spy_cache = load_spy_cache()
        deposit_codes = ('RTP', 'ACH', 'JNLE')

        # ── Investment events for benchmark "what-if" comparison ──
        # Bank deposits fund cash; transferred positions are treated as same-day
        # benchmark purchases without affecting cash balance.
        sorted_deposits = sorted(
            [tx for tx in cash_transactions
             if tx['trans_code'] in deposit_codes],
            key=lambda x: x['date']
        )
        sorted_purchases = sorted(raw_stocks, key=lambda x: x['buy_date'])

        transfer_events = [
            {'date': datetime.strptime(s['buy_date'], '%Y-%m-%d').date(),
             'amount': float(s['quantity']) * float(s['buy_price']),
             'cash_amount': 0.0}
            for s in sorted_purchases
            if not stock_uses_cash(s)
        ]

        if sorted_deposits:
            investment_events = [
                {'date': datetime.strptime(d['date'], '%Y-%m-%d').date(),
                 'amount': float(d['amount']),
                 'cash_amount': float(d['amount'])}
                for d in sorted_deposits
            ] + transfer_events
        else:
            investment_events = [
                {'date': datetime.strptime(s['buy_date'], '%Y-%m-%d').date(),
                 'amount': float(s['quantity']) * float(s['buy_price']),
                 'cash_amount': float(s['quantity']) * float(s['buy_price']) if stock_uses_cash(s) else 0.0}
                for s in sorted_purchases
            ]

        investment_events = sorted(investment_events, key=lambda x: x['date'])

        if not investment_events and not sorted_purchases:
            return jsonify(empty)

        # ── Date range ──
        candidate_dates = [e['date'] for e in investment_events]
        if sorted_purchases:
            candidate_dates.append(datetime.strptime(sorted_purchases[0]['buy_date'], '%Y-%m-%d').date())
        start_date = min(candidate_dates)
        end_date = date.today()

        # ── Fetch benchmark price histories ──
        # SPY reuses the persistent cache; others fetched fresh
        benchmark_history = {}
        for ticker in benchmark_tickers:
            if ticker == 'SPY':
                # Ensure SPY cache covers our range
                get_spy_data_with_cache(start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d'))
                benchmark_history['SPY'] = load_spy_cache()
            else:
                benchmark_history[ticker] = fetch_ticker_history(ticker, start_date, end_date)

        # ── Pre-compute benchmark shares acquired per investment event ──
        # For each event, buy as many shares of each benchmark as the deposit amount allows
        bm_shares_events = {t: [] for t in benchmark_tickers}
        for ev in investment_events:
            for ticker in benchmark_tickers:
                price = get_spy_price_from_cache(benchmark_history[ticker], ev['date'].strftime('%Y-%m-%d'))
                shares = ev['amount'] / price if price > 0 else 0
                bm_shares_events[ticker].append({'date': ev['date'], 'shares': shares})

        # ── Pre-fetch stock histories ──
        symbols = {s['symbol'] for s in sorted_purchases}
        symbol_history = {}
        for sym in symbols:
            symbol_history[sym] = fetch_ticker_history(sym, start_date, end_date)

        # ── Income flows (for cash balance) ──
        income_flows = sorted(
            [tx for tx in cash_transactions
             if tx['trans_code'] not in deposit_codes],
            key=lambda x: x['date']
        )
        income_data = [{'date': datetime.strptime(tx['date'], '%Y-%m-%d').date(),
                        'amount': float(tx['amount'])} for tx in income_flows]

        # ── Purchase data ──
        purchase_data = [
            {'date': datetime.strptime(s['buy_date'], '%Y-%m-%d').date(),
             'symbol': s['symbol'],
             'quantity': float(s['quantity']),
             'investment': float(s['quantity']) * float(s['buy_price']),
             'uses_cash': stock_uses_cash(s)}
            for s in sorted_purchases
        ]

        # ── Weekly timeline ──
        dates_out = []
        portfolio_values_out = []
        total_investments_out = []
        bm_values_out = {t: [] for t in benchmark_tickers}

        current_holdings = {}
        bm_cumulative_shares = {t: 0.0 for t in benchmark_tickers}
        cumulative_deposited = 0.0
        cumulative_principal = 0.0
        cumulative_stock_cost = 0.0
        cumulative_income = 0.0

        invest_idx = 0   # investment_events cursor (for benchmarks)
        purchase_idx = 0
        income_idx = 0
        # per-ticker cursor into bm_shares_events
        bm_event_idx = {t: 0 for t in benchmark_tickers}

        current_date = start_date
        last_processed_date = None
        
        while current_date <= end_date or last_processed_date != end_date:
            if current_date > end_date:
                current_date = end_date
                
            # Accumulate investment events for benchmark shares
            while invest_idx < len(investment_events) and investment_events[invest_idx]['date'] <= current_date:
                cumulative_deposited += investment_events[invest_idx]['cash_amount']
                cumulative_principal += investment_events[invest_idx]['amount']
                for ticker in benchmark_tickers:
                    idx = bm_event_idx[ticker]
                    while idx < len(bm_shares_events[ticker]) and bm_shares_events[ticker][idx]['date'] <= current_date:
                        bm_cumulative_shares[ticker] += bm_shares_events[ticker][idx]['shares']
                        idx += 1
                    bm_event_idx[ticker] = idx
                invest_idx += 1

            # Accumulate stock purchases
            while purchase_idx < len(purchase_data) and purchase_data[purchase_idx]['date'] <= current_date:
                p = purchase_data[purchase_idx]
                current_holdings[p['symbol']] = current_holdings.get(p['symbol'], 0) + p['quantity']
                if p['uses_cash']:
                    cumulative_stock_cost += p['investment']
                purchase_idx += 1

            # Accumulate income
            while income_idx < len(income_data) and income_data[income_idx]['date'] <= current_date:
                cumulative_income += income_data[income_idx]['amount']
                income_idx += 1

            has_activity = cumulative_deposited > 0 or current_holdings
            if has_activity:
                date_str = current_date.strftime('%Y-%m-%d')

                # Portfolio = stock value + uninvested cash
                portfolio_value = 0.0
                for sym, qty in current_holdings.items():
                    if qty > 0:
                        hist = symbol_history.get(sym, {})
                        price = None
                        if current_date in hist:
                            price = hist[current_date]
                        else:
                            for i in range(1, 31):
                                d = current_date - timedelta(days=i)
                                if d in hist:
                                    price = hist[d]
                                    break
                        if price is None:
                            price = get_current_stock_price(sym)
                        portfolio_value += qty * price

                cash_balance = cumulative_deposited + cumulative_income - cumulative_stock_cost
                portfolio_value += max(0, cash_balance)

                total_invested = cumulative_principal if cumulative_principal > 0 else cumulative_stock_cost

                dates_out.append(date_str)
                portfolio_values_out.append(round(portfolio_value, 2))
                total_investments_out.append(round(total_invested, 2))

                for ticker in benchmark_tickers:
                    bm_price = get_spy_price_from_cache(benchmark_history[ticker], date_str)
                    bm_val = bm_cumulative_shares[ticker] * bm_price if bm_price > 0 else 0
                    bm_values_out[ticker].append(round(bm_val, 2))

            last_processed_date = current_date
            if current_date == end_date:
                break
            current_date += timedelta(days=7)
            if current_date > end_date and last_processed_date < end_date:
                current_date = end_date


        return jsonify({
            'dates': dates_out,
            'portfolio_values': portfolio_values_out,
            'total_investments': total_investments_out,
            'benchmarks': bm_values_out
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/networth_data/<timeline>')
def networth_data_timeline(timeline):
    """Filtered networth data for a specific timeline."""
    try:
        full_response = networth_data()
        full_data = full_response.get_json()

        if 'status' in full_data and full_data['status'] == 'error':
            return full_response

        if timeline == 'ALL' or not full_data['dates']:
            return jsonify(full_data)

        end_date = date.today()
        days_map = {'1M': 30, '3M': 90, '6M': 180, '1Y': 365}
        start_date = (end_date - timedelta(days=days_map.get(timeline, 365))).strftime('%Y-%m-%d')

        idx_mask = [i for i, d in enumerate(full_data['dates']) if d >= start_date]
        if not idx_mask:
            return jsonify(full_data)

        filtered = {
            'dates': [full_data['dates'][i] for i in idx_mask],
            'portfolio_values': [full_data['portfolio_values'][i] for i in idx_mask],
            'total_investments': [full_data['total_investments'][i] for i in idx_mask],
            'benchmarks': {
                ticker: [vals[i] for i in idx_mask]
                for ticker, vals in full_data['benchmarks'].items()
            }
        }
        return jsonify(filtered)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

def get_spy_price_from_cache(spy_cache, date_str):
    """Get SPY price from cache using nearest trading day, cache-only.
    Preference: same day; else look backward up to 30 days; else forward up to 30 days;
    else pick nearest available from cache. No network fallbacks."""
    try:
        target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        # Exact match
        if target_date in spy_cache:
            return spy_cache[target_date]
        # Look backward up to 30 days
        for i in range(1, 31):
            d = target_date - timedelta(days=i)
            if d in spy_cache:
                return spy_cache[d]
        # Look forward up to 30 days
        for i in range(1, 31):
            d = target_date + timedelta(days=i)
            if d in spy_cache:
                return spy_cache[d]
        # Fallback to nearest available in cache (by absolute difference)
        if spy_cache:
            nearest_date = min(spy_cache.keys(), key=lambda d: abs(d - target_date))
            return spy_cache[nearest_date]
        return 0.0
    except Exception:
        return 0.0

# Removed old get_spy_price_for_date function - now using cache-only approach

def get_stock_price_for_date(symbol, date_str):
    """Get stock price for a specific date"""
    try:
        # For recent dates (within last 7 days), use current price
        target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        days_ago = (date.today() - target_date).days
        
        if days_ago <= 7:
            # Use current price for very recent dates
            return get_current_stock_price(symbol)
        
        # Get historical data
        ticker = yf.Ticker(symbol)
        start_date = target_date - timedelta(days=10)
        end_date = target_date + timedelta(days=5)
        
        hist_data = ticker.history(start=start_date, end=end_date)
        
        if not hist_data.empty:
            # Convert to timezone-naive for comparison
            hist_data_naive = hist_data.copy()
            hist_data_naive.index = hist_data_naive.index.tz_localize(None) if hist_data_naive.index.tz is None else hist_data_naive.index.tz_convert(None)
            
            # Look for exact date match first
            target_pd = pd.to_datetime(date_str).tz_localize(None)
            
            # Try exact date match
            exact_match = hist_data_naive[hist_data_naive.index.date == target_date]
            if not exact_match.empty:
                price = float(exact_match['Close'].iloc[0])
                return price
            
            # Find closest date
            closest_idx = hist_data_naive.index.get_indexer([target_pd], method='nearest')[0]
            
            if closest_idx >= 0 and closest_idx < len(hist_data_naive):
                price = float(hist_data_naive.iloc[closest_idx]['Close'])
                return price
        
        # Fallback to current price
        return get_current_stock_price(symbol)
        
    except Exception as e:
        print(f"Error getting price for {symbol} on {date_str}: {e}")
        return get_current_stock_price(symbol)

if __name__ == '__main__':
    app.run(debug=True, port=5001)

# Test endpoint to debug portfolio calculations
@app.route('/debug/portfolio')
def debug_portfolio():
    """Debug endpoint to check portfolio calculations"""
    try:
        raw_stocks = load_stocks_data()
        
        total_current_value = 0
        debug_info = []
        
        for stock in raw_stocks:
            current_price = get_current_stock_price(stock['symbol'])
            current_value = stock['quantity'] * current_price
            investment = stock['quantity'] * stock['buy_price']
            
            total_current_value += current_value
            
            debug_info.append({
                'symbol': stock['symbol'],
                'quantity': stock['quantity'],
                'buy_price': stock['buy_price'],
                'current_price': current_price,
                'investment': investment,
                'current_value': current_value,
                'buy_date': stock['buy_date']
            })
        
        return jsonify({
            'total_current_value': total_current_value,
            'total_positions': len(raw_stocks),
            'positions': debug_info
        })
    except Exception as e:
        return jsonify({'error': str(e)})
