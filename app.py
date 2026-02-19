from flask import Flask, render_template_string, request
from datetime import datetime, timedelta
import os
import time
import requests
from functools import lru_cache

app = Flask(__name__)

# Get API key from environment variable
POLYGON_API_KEY = os.environ.get('POLYGON_API_KEY', '')

# Cache for reducing API calls
cache = {}
CACHE_DURATION = 300  # 5 minutes

def fetch_stock_price(ticker):
    """Fetch current stock price from Polygon.io"""
    url = f"https://api.polygon.io/v2/aggs/ticker/{ticker}/prev?adjusted=true&apiKey={POLYGON_API_KEY}"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code != 200:
            return None, f"Error fetching price: {response.status_code}"
        
        data = response.json()
        if data.get('results') and len(data['results']) > 0:
            price = float(data['results'][0]['c'])  # closing price
            return price, None
        return None, "No price data available"
    except Exception as e:
        return None, f"Error: {str(e)}"

def fetch_options_chain(ticker):
    """Fetch options chain from Polygon.io"""
    url = f"https://api.polygon.io/v3/snapshot/options/{ticker}?limit=250&apiKey={POLYGON_API_KEY}"
    
    try:
        response = requests.get(url, timeout=15)
        if response.status_code != 200:
            return None, f"Error fetching options: {response.status_code}"
        
        data = response.json()
        return data.get('results', []), None
    except Exception as e:
        return None, f"Error: {str(e)}"

def fetch_options_data(ticker, max_delta_calls=0.18, max_delta_puts=0.18, filter_type='both'):
    """Fetch and process options data from Polygon.io"""
    
    ticker = ticker.upper()
    
    # Check cache first
    current_time = time.time()
    cache_key = f"{ticker}_{max_delta_calls}_{max_delta_puts}_{filter_type}"
    
    if ticker in cache:
        cached_data, cached_time = cache[ticker]
        if current_time - cached_time < CACHE_DURATION:
            print(f"Using cached data for {ticker}")
            return filter_cached_data(cached_data, max_delta_calls, max_delta_puts, filter_type)
    
    if not POLYGON_API_KEY:
        return None, "API key not configured. Please add POLYGON_API_KEY environment variable in Render dashboard."
    
    print(f"Fetching fresh data for {ticker}")
    
    # Fetch stock price
    price, error = fetch_stock_price(ticker)
    if error:
        return None, f"Could not fetch price for {ticker}: {error}"
    
    print(f"Price for {ticker}: ${price}")
    
    # Small delay between API calls
    time.sleep(0.5)
    
    # Fetch options chain
    options_data, error = fetch_options_chain(ticker)
    if error:
        return None, f"Could not fetch options for {ticker}: {error}"
    
    if not options_data:
        return None, f"No options data available for {ticker}"
    
    print(f"Received {len(options_data)} options contracts")
    
    # Process options
    all_options = []
    today = datetime.now()
    
    for option in options_data:
        try:
            details = option.get('details', {})
            greeks = option.get('greeks', {})
            last_quote = option.get('last_quote', {})
            
            contract_type = details.get('contract_type')
            strike = details.get('strike_price')
            expiration_str = details.get('expiration_date')
            
            if not all([contract_type, strike, expiration_str]):
                continue
            
            # Parse expiration
            try:
                exp_date = datetime.strptime(expiration_str, "%Y-%m-%d")
            except:
                continue
            
            days_to_exp = (exp_date - today).days
            if days_to_exp <= 0 or days_to_exp > 90:
                continue
            
            # Filter by option type
            if contract_type == 'call' and filter_type == 'puts':
                continue
            if contract_type == 'put' and filter_type == 'calls':
                continue
            
            # Filter by moneyness
            if contract_type == 'call' and strike <= price:
                continue
            if contract_type == 'put' and strike >= price:
                continue
            
            # Get pricing data
            bid = last_quote.get('bid', 0) or 0
            ask = last_quote.get('ask', 0) or 0
            premium = (bid + ask) / 2
            
            if premium < 0.05:
                continue
            
            # Get or estimate delta
            delta = greeks.get('delta', 0)
            if delta == 0 or delta is None:
                # Estimate delta if not provided
                moneyness = abs((strike - price) / price)
                time_factor = days_to_exp / 365
                delta = min(0.5, 1.0 / (1.0 + moneyness * 10 / (time_factor ** 0.5)))
            else:
                delta = abs(float(delta))
            
            # Filter by delta
            if contract_type == 'call' and delta > max_delta_calls:
                continue
            if contract_type == 'put' and delta > max_delta_puts:
                continue
            
            # Calculate annualized return
            annual_return = (premium / price) * (365 / days_to_exp) * 100
            
            all_options.append({
                'type': 'Call' if contract_type == 'call' else 'Put',
                'strike': float(strike),
                'expiration': exp_date.strftime('%b %d, %Y'),
                'days': days_to_exp,
                'premium': premium,
                'bid': bid,
                'ask': ask,
                'delta': delta,
                'annual_return': annual_return,
                'volume': option.get('day', {}).get('volume', 0) or 0,
                'oi': option.get('open_interest', 0) or 0
            })
            
        except Exception as e:
            print(f"Error processing option: {e}")
            continue
    
    # Sort by annual return
    all_options.sort(key=lambda x: x['annual_return'], reverse=True)
    
    result = {
        'symbol': ticker,
        'price': price,
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'options': all_options[:30],
        'max_delta_calls': max_delta_calls,
        'max_delta_puts': max_delta_puts,
        'filter_type': filter_type,
        'all_options': all_options
    }
    
    # Cache the result
    cache[ticker] = (result, current_time)
    
    if len(all_options) == 0:
        return None, f"No options found for {ticker} matching delta â¤ {max_delta_calls:.2f} (calls) / {max_delta_puts:.2f} (puts). Try increasing the delta filters."
    
    print(f"Found {len(all_options)} matching options for {ticker}")
    return result, None

def filter_cached_data(cached_result, max_delta_calls, max_delta_puts, filter_type):
    """Filter cached data with new parameters"""
    all_opts = cached_result.get('all_options', [])
    
    filtered = []
    for opt in all_opts:
        if opt['type'] == 'Call':
            if filter_type in ['both', 'calls'] and opt['delta'] <= max_delta_calls:
                filtered.append(opt)
        else:
            if filter_type in ['both', 'puts'] and opt['delta'] <= max_delta_puts:
                filtered.append(opt)
    
    filtered.sort(key=lambda x: x['annual_return'], reverse=True)
    
    result = cached_result.copy()
    result['options'] = filtered[:30]
    result['max_delta_calls'] = max_delta_calls
    result['max_delta_puts'] = max_delta_puts
    result['filter_type'] = filter_type
    result['timestamp'] = cached_result['timestamp'] + " (cached)"
    
    if len(filtered) == 0:
        return None, f"No options match delta â¤ {max_delta_calls:.2f} (calls) / {max_delta_puts:.2f} (puts)"
    
    return result, None

# HTML template (same as before)
HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Options Analyzer - {{ symbol }}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
            color: white;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 15px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .header h1 { margin: 0 0 10px 0; font-size: 28px; }
        .price { font-size: 36px; font-weight: bold; color: #10b981; }
        .controls {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 15px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .control-section { margin-bottom: 20px; }
        .control-section:last-child { margin-bottom: 0; }
        .control-label {
            display: block;
            font-size: 14px;
            font-weight: 600;
            color: #94a3b8;
            margin-bottom: 8px;
        }
        .ticker-input {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .ticker-input input {
            flex: 1;
            min-width: 150px;
            padding: 12px 16px;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            color: white;
            font-size: 16px;
        }
        .ticker-input input::placeholder { color: #64748b; }
        .ticker-input button, .btn {
            padding: 12px 24px;
            background: #10b981;
            border: none;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            font-size: 14px;
        }
        .ticker-input button:hover, .btn:hover { background: #059669; }
        .quick-picks {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 10px;
        }
        .quick-picks a {
            padding: 8px 16px;
            background: rgba(59, 130, 246, 0.2);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            border: 1px solid rgba(59, 130, 246, 0.3);
            font-weight: 600;
            font-size: 14px;
        }
        .quick-picks a:hover { background: rgba(59, 130, 246, 0.3); }
        .slider-container { margin-top: 10px; }
        .slider {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: rgba(255,255,255,0.2);
            outline: none;
            -webkit-appearance: none;
        }
        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #10b981;
            cursor: pointer;
        }
        .slider::-moz-range-thumb {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #10b981;
            cursor: pointer;
            border: none;
        }
        .slider-value {
            display: inline-block;
            margin-left: 10px;
            font-weight: 600;
            color: #10b981;
        }
        .filter-buttons {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .filter-btn {
            flex: 1;
            padding: 12px;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            text-align: center;
            text-decoration: none;
            font-size: 14px;
        }
        .filter-btn.active {
            background: #3b82f6;
            border-color: #3b82f6;
        }
        .filter-btn:hover { background: rgba(59, 130, 246, 0.3); }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
        }
        .card {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .card-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .strike { font-size: 24px; font-weight: bold; }
        .annual-return {
            font-size: 20px;
            font-weight: bold;
            color: #10b981;
        }
        .type-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .type-call { background: #3b82f6; }
        .type-put { background: #8b5cf6; }
        .metric {
            display: flex;
            justify-content: space-between;
            padding: 6px 0;
            font-size: 14px;
        }
        .metric-label { color: #94a3b8; }
        .metric-value { font-weight: 600; }
        .timestamp {
            text-align: center;
            color: #64748b;
            margin: 30px 0;
            font-size: 14px;
        }
        @media (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
            .header h1 { font-size: 24px; }
            .price { font-size: 28px; }
            .filter-buttons { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>ð Options Strategy Analyzer</h1>
            <div class="price">{{ symbol }}: ${{ "%.2f"|format(price) }}</div>
            <p style="color: #94a3b8; margin: 5px 0 0 0;">{{ timestamp }} â¢ Powered by Polygon.io</p>
        </div>

        <div class="controls">
            <div class="control-section">
                <label class="control-label">Ticker Symbol</label>
                <form class="ticker-input" method="GET" action="/">
                    <input type="text" name="symbol" placeholder="Enter ticker (e.g., AAPL)" value="{{ symbol }}" required>
                    <input type="hidden" name="delta_calls" value="{{ max_delta_calls }}">
                    <input type="hidden" name="delta_puts" value="{{ max_delta_puts }}">
                    <input type="hidden" name="filter" value="{{ filter_type }}">
                    <button type="submit">Analyze</button>
                </form>
                <div class="quick-picks">
                    <a href="/?symbol=SPY&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter={{ filter_type }}">SPY</a>
                    <a href="/?symbol=GS&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter={{ filter_type }}">GS</a>
                    <a href="/?symbol=QQQM&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter={{ filter_type }}">QQQM</a>
                    <a href="/?symbol=IVV&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter={{ filter_type }}">IVV</a>
                </div>
            </div>

            <div class="control-section">
                <label class="control-label">Max Delta - Calls<span class="slider-value">{{ "%.2f"|format(max_delta_calls) }}</span></label>
                <div class="slider-container">
                    <input type="range" class="slider" min="0.05" max="0.50" step="0.01" value="{{ max_delta_calls }}" 
                           onchange="window.location.href='/?symbol={{ symbol }}&delta_calls='+this.value+'&delta_puts={{ max_delta_puts }}&filter={{ filter_type }}'">
                </div>
            </div>

            <div class="control-section">
                <label class="control-label">Max Delta - Puts<span class="slider-value">{{ "%.2f"|format(max_delta_puts) }}</span></label>
                <div class="slider-container">
                    <input type="range" class="slider" min="0.05" max="0.50" step="0.01" value="{{ max_delta_puts }}"
                           onchange="window.location.href='/?symbol={{ symbol }}&delta_calls={{ max_delta_calls }}&delta_puts='+this.value+'&filter={{ filter_type }}'">
                </div>
            </div>

            <div class="control-section">
                <label class="control-label">Show Options</label>
                <div class="filter-buttons">
                    <a href="/?symbol={{ symbol }}&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter=both" 
                       class="filter-btn {% if filter_type == 'both' %}active{% endif %}">Both</a>
                    <a href="/?symbol={{ symbol }}&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter=calls" 
                       class="filter-btn {% if filter_type == 'calls' %}active{% endif %}">Calls Only</a>
                    <a href="/?symbol={{ symbol }}&delta_calls={{ max_delta_calls }}&delta_puts={{ max_delta_puts }}&filter=puts" 
                       class="filter-btn {% if filter_type == 'puts' %}active{% endif %}">Puts Only</a>
                </div>
            </div>
        </div>

        {% if error %}
        <div class="card" style="background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.5);">
            <p>â Error: {{ error }}</p>
        </div>
        {% else %}
        <h2 style="margin: 30px 0 20px 0;">Top Income Opportunities</h2>
        <div class="grid">
            {% for opt in options %}
            <div class="card">
                <span class="type-badge type-{{ opt.type.lower() }}">{{ opt.type }}</span>
                <div class="card-header">
                    <div class="strike">${{ "%.2f"|format(opt.strike) }}</div>
                    <div class="annual-return">{{ "%.1f"|format(opt.annual_return) }}%</div>
                </div>
                <div class="metric">
                    <span class="metric-label">Expiration</span>
                    <span class="metric-value">{{ opt.expiration }} ({{ opt.days }}d)</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Premium</span>
                    <span class="metric-value" style="color: #10b981;">${{ "%.2f"|format(opt.premium) }}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Bid / Ask</span>
                    <span class="metric-value">${{ "%.2f"|format(opt.bid) }} / ${{ "%.2f"|format(opt.ask) }}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Delta</span>
                    <span class="metric-value">{{ "%.3f"|format(opt.delta) }}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Volume</span>
                    <span class="metric-value">{{ "{:,}".format(opt.volume) }}</span>
                </div>
                <div class="metric">
                    <span class="metric-label">Open Interest</span>
                    <span class="metric-value">{{ "{:,}".format(opt.oi) }}</span>
                </div>
            </div>
            {% endfor %}
        </div>
        {% endif %}

        <div class="timestamp">
            ð¡ Data cached for 5 minutes â¢ Updates refresh automatically
        </div>
    </div>
</body>
</html>
"""

@app.route('/')
def home():
    symbol = request.args.get('symbol', 'SPY').upper()
    delta_calls = float(request.args.get('delta_calls', 0.18))
    delta_puts = float(request.args.get('delta_puts', 0.18))
    filter_type = request.args.get('filter', 'both')
    
    print(f"Request: {symbol} (Calls Îâ¤{delta_calls}, Puts Îâ¤{delta_puts}, Filter: {filter_type})")
    
    data, error = fetch_options_data(symbol, delta_calls, delta_puts, filter_type)
    
    if error:
        return render_template_string(HTML_TEMPLATE, 
            symbol=symbol, 
            price=0, 
            timestamp=datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            error=error,
            options=[],
            max_delta_calls=delta_calls,
            max_delta_puts=delta_puts,
            filter_type=filter_type)
    
    return render_template_string(HTML_TEMPLATE, **data, error=None)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)


