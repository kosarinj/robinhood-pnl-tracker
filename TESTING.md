# Testing the Multi-Client Server Setup

## Current Status: ✅ READY FOR TESTING

### What's Running:
- ✅ **Server**: http://localhost:3001 (WebSocket + REST API)
- ✅ **Frontend**: http://localhost:5175 (React + Vite)
- ✅ **Connection**: WebSocket clients successfully connecting

### Server Logs Show:
```
🚀 Server running on port 3001
📊 WebSocket server ready for connections
💰 Price updates every 1 minute
📈 Signal updates on-demand
Client connected: ujTtzmbpty0TfEaSAAAO
```

## How to Test

### 1. Test CSV Upload via WebSocket

**Steps:**
1. Open browser: http://localhost:5175
2. Check for connection indicator:
   - ✅ Green: "Connected to server - Real-time updates enabled"
   - ❌ Red: "Not connected to server - Check if server is running"
3. Click "📁 Upload CSV" button
4. Select your Robinhood CSV file
5. Watch the console logs (F12 → Console):
   ```
   Connecting to WebSocket server...
   ✅ Connected to server: <socket-id>
   📤 Uploading CSV to server...
   ✅ CSV processed by server
   Server response: X symbols, principal: $XX,XXX
   ```
6. Verify the P&L grid displays correctly

**Expected Result:**
- All trades parsed correctly
- Current prices fetched from Yahoo Finance
- P&L calculations displayed in grid
- Principal shown correctly
- Failed symbols (if any) displayed with warning

---

### 2. Test Real-Time Price Updates

**Prerequisites:** CSV must be uploaded first

**Steps:**
1. After CSV upload, note the current prices in the grid
2. Wait 1 minute
3. Check server logs for:
   ```
   Price update broadcast to 1 clients
   ```
4. Check browser console for:
   ```
   📈 Received price update from server
   ```
5. Verify the "Last updated" timestamp changes
6. Verify P&L values update (if prices changed)

**Expected Result:**
- Server fetches prices every 1 minute
- Updates broadcast to all connected clients
- P&L recalculated automatically
- Timestamp updates

---

### 3. Test Multi-Client Functionality

**Steps:**
1. **Window 1**: Keep http://localhost:5175 open with CSV uploaded
2. **Window 2**: Open http://localhost:5175 in a new browser window (or incognito)
3. Check server logs for:
   ```
   Client connected: <socket-id-1>
   Client connected: <socket-id-2>
   ```
4. **Window 2**: Upload the same CSV file
5. Wait 1 minute for price update
6. Check server logs for:
   ```
   Price update broadcast to 2 clients
   ```
7. Verify BOTH windows receive the update

**Expected Result:**
- Both clients connect independently
- Both clients receive price updates every minute
- Server broadcasts to all connected clients
- Each client maintains its own session data

---

### 4. Test Manual Price Override

**Steps:**
1. Upload CSV
2. Click "Edit" button next to any symbol
3. Enter a custom price
4. Check if server receives update:
   - Server logs should show manual price update event
5. Verify P&L recalculates with new price

**Expected Result:**
- Manual price sent to server via WebSocket
- Server recalculates P&L
- Updated P&L sent back to client
- Other clients (if any) see the update

---

### 5. Test Split Adjustment

**Steps:**
1. Upload CSV
2. Click "Split" button next to any symbol
3. Enter split ratio (e.g., 2 for 2:1 split)
4. Check if server receives update
5. Verify prices adjust correctly

**Expected Result:**
- Split adjustment sent to server
- Server adjusts historical trade prices
- Recalculates P&L
- Updates broadcast to client

---

## Testing Checklist

### Server Connection
- [ ] Server starts without errors on port 3001
- [ ] Frontend connects to WebSocket
- [ ] Green connection indicator shows in UI
- [ ] Server logs show "Client connected"

### CSV Upload
- [ ] File upload button works
- [ ] CSV parsed correctly
- [ ] Trades displayed in grid
- [ ] Prices fetched from Yahoo Finance
- [ ] P&L calculations correct
- [ ] Principal calculated from ACH deposits
- [ ] Failed symbols displayed (if any)

### Real-Time Updates
- [ ] Server fetches prices every 1 minute
- [ ] Updates broadcast to all clients
- [ ] Browser console shows "Received price update"
- [ ] P&L values update automatically
- [ ] Timestamp updates

### Multi-Client
- [ ] Multiple browser windows can connect
- [ ] Each maintains separate session
- [ ] All receive price updates simultaneously
- [ ] Server logs show correct client count

### Manual Operations
- [ ] Manual price override works
- [ ] Split adjustment works
- [ ] Server recalculates P&L
- [ ] Updates broadcast to clients

---

## Troubleshooting

### Connection Failed
**Problem**: Red indicator "Not connected to server"

**Solution**:
1. Check if server is running: http://localhost:3001/health
2. Check server logs for errors
3. Verify `.env.local` has: `VITE_SERVER_URL=http://localhost:3001`
4. Refresh browser page

---

### Port Already in Use
**Problem**: Server won't start - "Port 3001 already in use"

**Solution**:
```bash
# Find process using port 3001
netstat -ano | findstr :3001

# Kill the process
taskkill /PID <PID> /F

# Restart server
cd server
npm start
```

---

### CSV Upload Fails
**Problem**: Error message after uploading CSV

**Check**:
1. Server logs for detailed error
2. Browser console for error details
3. CSV file format matches Robinhood export

**Solution**:
- Verify CSV has required columns: Activity Date, Instrument, Description, Trans Code, Quantity, Price, Amount
- Check for special characters or encoding issues
- Try re-exporting CSV from Robinhood

---

### Prices Not Updating
**Problem**: Last update timestamp doesn't change

**Check**:
1. Server logs: Should show "Price update broadcast to X clients" every minute
2. Browser console: Should show "📈 Received price update from server"
3. Connection status: Should be green

**Solution**:
- Refresh browser page
- Check if Yahoo Finance is accessible
- Restart server if needed

---

## Next Steps After Testing

### If All Tests Pass:
1. ✅ Local testing complete
2. 🚀 Ready for deployment
3. Choose hosting platform:
   - **Render.com** (free, sleeps after 15 min)
   - **Railway.app** ($5/mo, always on)
   - **Fly.io** (free tier, 3 VMs)

### If Tests Fail:
1. Review error messages in:
   - Server logs
   - Browser console
   - Network tab (F12 → Network → WS)
2. Check GitHub issues or documentation
3. Review code changes in App.jsx and server/index.js

---

## Console Commands Reference

### Server
```bash
# Start server
cd server
npm start

# Check health
curl http://localhost:3001/health
```

### Frontend
```bash
# Start frontend
npm run dev

# Build for production
npm run build
```

### Monitoring
```bash
# Watch server logs
cd server
npm start

# Watch frontend build
npm run dev
```

---

## Success Metrics

✅ **Connection Established**: Green indicator in UI
✅ **CSV Upload Works**: Trades displayed in grid
✅ **Prices Auto-Update**: Timestamp changes every minute
✅ **Multi-Client Works**: 2+ windows receive updates
✅ **Manual Overrides Work**: Edit/split buttons functional
✅ **No Errors**: Clean console and server logs

When all metrics pass → **READY FOR DEPLOYMENT** 🚀
