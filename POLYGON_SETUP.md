# Polygon.io Integration Setup

## Overview

Your Robinhood PNL Tracker now uses **dual data sources**:

- **Yahoo Finance**: For real-time current prices (fast, reliable, free)
- **Polygon.io**: For intraday historical data used in trading signal generation (high quality, generous free tier)

## Why Polygon.io?

Compared to Alpha Vantage:
- ✅ Better free tier (5 requests/min vs strict limits)
- ✅ More reliable data quality
- ✅ Real-time market data
- ✅ Better API documentation
- ✅ WebSocket support (future enhancement)
- ✅ No "premium only" features blocking common use cases

## Getting Your Free Polygon API Key

1. **Sign up** at https://polygon.io/
   - Click "Get Started" or "Sign Up"
   - Create a free account (no credit card required)

2. **Get your API key**
   - After signup, you'll be redirected to your dashboard
   - Copy your API key from the dashboard

3. **Configure the app**
   - Navigate to `server/` directory
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` and paste your API key:
     ```
     POLYGON_API_KEY=your_actual_api_key_here
     ```

## Free Tier Limits

Polygon.io Free Tier includes:
- **5 API calls per minute**
- **Delayed data** (15 minute delay)
- **2 years of historical data**
- **Unlimited symbols**

The app is configured to respect rate limits:
- Signals are fetched with 12-second delays between symbols
- Data is cached for 5 minutes
- Automatic signal recording happens every 5 minutes

## Fallback to Alpha Vantage

If you prefer to keep using Alpha Vantage or encounter issues with Polygon:

**Option 1: Environment Variable**
Set in `.env`:
```
USE_POLYGON=false
```

**Option 2: No API Key**
If no Polygon API key is set, the app will automatically fall back to Alpha Vantage.

## Verification

After setup, restart the server:
```bash
cd server
npm run dev
```

You should see in the console:
```
📊 Signal Data Source: Polygon.io
💡 Get your free Polygon API key at https://polygon.io/
   Set POLYGON_API_KEY in environment or .env file
```

When signals are fetched, you'll see:
```
✅ Polygon: Fetched 250 bars for AAPL
```

## Troubleshooting

### "Polygon API key invalid or unauthorized"
- Double-check your API key in `.env`
- Ensure no extra spaces or quotes
- Verify your Polygon account is activated

### "Polygon API rate limit exceeded"
- Free tier allows 5 requests/minute
- The app automatically delays between requests
- Reduce the number of symbols being tracked if needed

### "No intraday data available"
- Some symbols may not have recent trading activity
- Check if the market is open (Polygon requires trading activity)
- Try a more actively traded symbol like AAPL or SPY

### Want to use Alpha Vantage instead?
Set `USE_POLYGON=false` in your `.env` file.

## Future Enhancements

With Polygon.io, we can add:
- 🔮 Real-time signal updates (WebSocket)
- 📊 More sophisticated technical indicators
- 🎯 Improved signal accuracy with higher resolution data
- 📈 Extended historical analysis

## Cost Comparison

| Feature | Polygon Free | Alpha Vantage Free |
|---------|-------------|-------------------|
| Rate Limit | 5/min | 5/min (strict) |
| Data Quality | Excellent | Good |
| Historical | 2 years | Limited |
| Real-time | Yes (delayed) | No |
| WebSocket | Yes | Premium only |
| Reliability | High | Medium |

## Support

- Polygon Docs: https://polygon.io/docs
- Get Help: https://polygon.io/discord (active community)
