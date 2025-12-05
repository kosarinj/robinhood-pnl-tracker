# Robinhood P&L Tracker - Server

Backend service for the Robinhood P&L Tracker with real-time price updates via WebSocket.

## Features

- **WebSocket Server**: Real-time bidirectional communication with clients
- **Automatic Price Updates**: Fetches prices from Yahoo Finance every 1 minute
- **Trading Signals**: On-demand signal generation using Alpha Vantage
- **Multi-Client Support**: Multiple clients can connect simultaneously
- **Centralized Price Fetching**: Single service fetches prices for all clients
- **Stateless Sessions**: No database required (sessions stored in memory)

## Architecture

```
Client (React App)
    ↓ WebSocket
Server (Node.js + Socket.IO)
    ↓
├─ Yahoo Finance API (Prices every 1 min)
└─ Alpha Vantage API (Trading Signals on-demand)
```

## Installation

1. Navigate to the server directory:
```bash
cd server
```

2. Install dependencies:
```bash
npm install
```

## Running the Server

### Development Mode (with auto-reload):
```bash
npm run dev
```

### Production Mode:
```bash
npm start
```

The server will start on port `3001` by default (or the PORT environment variable if set).

## API Endpoints

### WebSocket Events

**Client → Server:**

- `upload-csv`: Upload CSV content
  ```js
  socket.emit('upload-csv', { csvContent: '...' })
  ```

- `update-manual-price`: Update price manually
  ```js
  socket.emit('update-manual-price', { symbol: 'AAPL', price: 150.00 })
  ```

- `update-split`: Update stock split ratio
  ```js
  socket.emit('update-split', { symbol: 'TSLA', ratio: 3 })
  ```

- `request-signals`: Request trading signals for symbols
  ```js
  socket.emit('request-signals', { symbols: ['AAPL', 'GOOGL'] })
  ```

- `lookup-signal`: Lookup signal for a single symbol
  ```js
  socket.emit('lookup-signal', { symbol: 'MSFT' })
  ```

**Server → Client:**

- `csv-processed`: CSV processing complete
  ```js
  {
    success: true,
    data: {
      trades,
      pnlData,
      totalPrincipal,
      deposits,
      currentPrices
    }
  }
  ```

- `price-update`: Automatic price update (every 1 minute)
  ```js
  {
    currentPrices: { AAPL: 150.23, ... },
    pnlData: [...],
    timestamp: Date
  }
  ```

- `pnl-update`: P&L recalculation after manual update
  ```js
  {
    pnlData: [...],
    currentPrices: { ... }
  }
  ```

- `signals-update`: Trading signals response
  ```js
  {
    signals: [...]
  }
  ```

- `lookup-signal-result`: Single symbol signal result
  ```js
  {
    signal: { ... }
  }
  ```

### HTTP Endpoints

- `GET /health`: Server health check
  ```json
  {
    "status": "healthy",
    "clients": 2,
    "trackedSymbols": 25,
    "uptime": 3600
  }
  ```

- `GET /prices?symbols=AAPL,GOOGL`: Get current prices
  ```json
  {
    "AAPL": 150.23,
    "GOOGL": 2750.50
  }
  ```

## Environment Variables

- `PORT`: Server port (default: 3001)
- `NODE_ENV`: Environment (development/production)

## Deployment

### Render.com (Free)
1. Create account on Render.com
2. New Web Service → Connect GitHub repo
3. Build Command: `cd server && npm install`
4. Start Command: `cd server && npm start`
5. Deploy!

### Railway.app ($5/month)
1. Create account on Railway.app
2. New Project → Deploy from GitHub
3. Set root directory: `server`
4. Deploy!

### Fly.io (Free tier)
1. Install flyctl: `brew install flyctl`
2. Login: `flyctl auth login`
3. Launch: `cd server && flyctl launch`
4. Deploy: `flyctl deploy`

## How It Works

1. **Client connects** via WebSocket
2. **Client uploads CSV** → Server parses trades and deposits
3. **Server fetches initial prices** from Yahoo Finance
4. **Server calculates P&L** and sends to client
5. **Background job runs every 1 minute**:
   - Fetches updated prices for all tracked symbols
   - Recalculates P&L for each client session
   - Broadcasts updates to all connected clients
6. **Client requests trading signals** → Server fetches from Alpha Vantage and responds

## Testing Locally

1. Start the server:
```bash
cd server
npm run dev
```

2. Test WebSocket connection:
```js
// In browser console
const socket = io('http://localhost:3001')
socket.on('connect', () => console.log('Connected!'))
```

3. Check health endpoint:
```bash
curl http://localhost:3001/health
```

## Notes

- **Stateless**: All sessions stored in memory. Restarting server clears all sessions.
- **No Auth**: Currently no authentication. Add later if needed.
- **Rate Limits**: Yahoo Finance and Alpha Vantage have rate limits. Server handles this with caching.
- **Scalability**: For many users, consider Redis for shared state across multiple server instances.

## Next Steps

- [ ] Connect frontend to server
- [ ] Test with multiple clients
- [ ] Deploy to hosting service
- [ ] Add user authentication (optional)
- [ ] Add database for persistence (optional)
- [ ] Set up monitoring/logging

## Troubleshooting

**Port already in use:**
```bash
# Kill process on port 3001 (Windows)
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# Or use different port
PORT=3002 npm start
```

**WebSocket connection refused:**
- Check firewall settings
- Ensure CORS is enabled
- Verify client is connecting to correct URL

**Price fetching fails:**
- Check internet connection
- Verify Yahoo Finance API is accessible
- Check console for error messages
