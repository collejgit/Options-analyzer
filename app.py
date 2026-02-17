from flask import Flask, render_template_string, request
import yfinance as yf
from datetime import datetime, timedelta
import os
import time
import requests

app = Flask(__name__)

# Configure requests session with proper headers to avoid blocking
def create_yf_session():
    """Create a requests session with proper headers"""
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    })
    return session

def fetch_options_data(ticker, max_delta_calls=0.18, max_delta_puts=0.18, filter_type='both'):
    """Fetch options data with retry logic and proper headers"""
    
    # Create session with proper headers
    session = create_yf_session()
    
    # Retry logic for yfinance
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Create ticker with custom session
            stock = yf.Ticker(ticker, session=session)
            
            # Try to get history with timeout
            hist = stock.history(period="5d")  # Get more days in case of holidays
            
            if hist.empty:
                if attempt < max_retries - 1:
                    print(f"Retry {attempt + 1} for {ticker} - empty history")
                    time.sleep(2)  # Wait longer before retry
                    continue
                return None, f"No price data found for {ticker}. The symbol may be invalid or the market may be closed."
            
            # Get the most recent price
            price = float(hist['Close'].iloc[-1])
            print(f"Got price for {ticker}: ${price}")
            
            # Get options expiration dates
            try:
                expirations = stock.options
                print(f"Got {len(expirations)} expirations for {ticker}")
            except Exception as e:
                if attempt < max_retries - 1:
                    print(f"Retry {attempt + 1} for {ticker} - error getting expirations: {e}")
                    time.sleep(2)
                    continue
                return None, f"No options available for {ticker}. This stock may not have listed options."
            
            if not expirations or len(expirations) == 0:
                return None, f"No options available for {ticker}"
            
            break  # Success, exit retry loop
            
        except Exception as e:
            print(f"Error on attempt {attempt + 1} for {ticker}: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(2)
                continue
            return None, f"Error fetching data for {ticker}. Yahoo Finance may be temporarily unavailable. Please try again in a moment."
    
    all_options = []
    today = datetime.now()
    limit = today + timedelta(days=90)
    
    # Process options chains
    processed_count = 0
    for exp_str in expirations[:15]:
        try:
            exp_date = datetime.strptime(exp_str, "%Y-%m-%d")
            if exp_date > limit:
                continue
            
            # Fetch options chain with error handling
            try:
                chain = stock.option_chain(exp_str)
                processed_count += 1
                print(f"Processing chain {processed_count} for {exp_str}")
            except Exception as e:
                print(f"Error fetching chain for {exp_str}: {e}")
                continue
            
            days_to_exp = (exp_date - today).days
            
            if days_to_exp <= 0:
                continue
            
            # Process calls
            if filter_type in ['both', 'calls']:
                try:
                    for _, row in chain.calls.iterrows():
                        try:
                            strike = float(row['strike'])
                            if strike <= price:
                                continue
                            
                            bid = float(row.get('bid', 0)) if row.get('bid') is not None else 0
                            ask = float(row.get('ask', 0)) if row.get('ask') is not None else 0
                            premium = (bid + ask) / 2
                            
                            if premium < 0.05:
                                continue
                            
                            moneyness = abs((strike - price) / price)
                            time_factor = days_to_exp / 365
                            delta = min(0.5, 1.0 / (1.0 + moneyness * 10 / (time_factor ** 0.5)))
                            
                            if delta > max_delta_calls:
                                continue
                            
                            annual_return = (premium / price) * (365 / days_to_exp) * 100
                            
                            all_options.append({
                                'type': 'Call',
                                'strike': strike,
                                'expiration': exp_date.strftime('%b %d, %Y'),
                                'days': days_to_exp,
                                'premium': premium,
                                'bid': bid,
                                'ask': ask,
                                'delta': delta,
                                'annual_return': annual_return,
                                'volume': int(row.get('volume', 0)) if row.get('volume') is not None else 0,
                                'oi': int(row.get('openInterest', 0)) if row.get('openInterest') is not None else 0
                            })
                        except Exception as e:
                            continue
                except Exception as e:
                    print(f"Error processing calls: {e}")
            
            # Process puts
            if filter_type in ['both', 'puts']:
                try:
                    for _, row in chain.puts.iterrows():
                        try:
                            strike = float(row['strike'])
                            if strike >= price:
                                continue
                            
                            bid = float(row.get('bid', 0)) if row.get('bid') is not None else 0
                            ask = float(row.get('ask', 0)) if row.get('ask') is not None else 0
                            premium = (bid + ask) / 2
                            
                            if premium < 0.05:
                                continue
                            
                            moneyness = abs((strike - price) / price)
                            time_factor = days_to_exp / 365
                            delta = min(0.5, 1.0 / (1.0 + moneyness * 10 / (time_factor ** 0.5)))
                            
                            if delta > max_delta_puts:
                                continue
                            
                            annual_return = (premium / price) * (365 / days_to_exp) * 100
                            
                            all_options.append({
                                'type': 'Put',
                                'strike': strike,
                                'expiration': exp_date.strftime('%b %d, %Y'),
                                'days': days_to_exp,
                                'premium': premium,
                                'bid': bid,
                                'ask': ask,
                                'delta': delta,
                                'annual_return': annual_return,
                                'volume': int(row.get('volume', 0)) if row.get('volume') is not None else 0,
                                'oi': int(row.get('openInterest', 0)) if row.get('openInterest') is not None else 0
                            })
                        except Exception as e:
                            continue
                except Exception as e:
                    print(f"Error processing puts: {e}")
                    
        except Exception as e:
            print(f"Error processing expiration {exp_str}: {e}")
            continue
    
    all_options.sort(key=lambda x: x['annual_return'], reverse=True)
    
    print(f"Total options found: {len(all_options)}")
    
    if len(all_options) == 0:
        return None, f"No options found matching your criteria for {ticker}. Try adjusting the delta filters (current: calls ≤{max_delta_calls:.2f}, puts ≤{max_delta_puts:.2f})."
    
    return {
        'symbol': ticker,
        'price': price,
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'options': all_options[:30],
        'max_delta_calls': max_delta_calls,
        'max_delta_puts': max_delta_puts,
        'filter_type': filter_type
    }, None

# HTML template - same as before
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
            <h1>📊 Options Strategy Analyzer</h1>
            <div class="price">{{ symbol }}: ${{ "%.2f"|format(price) }}</div>
            <p style="color: #94a3b8; margin: 5px 0 0 0;">{{ timestamp }}</p>
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
            <p>❌ Error: {{ error }}</p>
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
                    <span class="metric-label">Delta (est.)</span>
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
            💡 Tip: Adjust delta sliders and filters above, then bookmark your custom view
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
    
    print(f"Request: {symbol} (Calls Δ≤{delta_calls}, Puts Δ≤{delta_puts}, Filter: {filter_type})")
    
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

