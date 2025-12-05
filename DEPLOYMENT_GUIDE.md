# Deployment Guide - Multi-Client Server

## Overview

You now have TWO versions of your app:
1. **Standalone** - Current React app (works offline, no server needed)
2. **Server-Based** - New architecture with real-time updates

## Architecture

```
Multiple Clients → WebSocket → Node.js Server → APIs
                                      ↓
                              (Yahoo Finance + Alpha Vantage)
```

## Quick Start - Test Locally

### Step 1: Start Server (Already Running! ✓)
```bash
cd server
npm start
```
Server: http://localhost:3001

### Step 2: Start Frontend
```bash
# In new terminal
npm run dev
```
Frontend: http://localhost:5173

### Step 3: Test Connection
Open browser console and check for:
```
✅ Connected to server: abc123
```

## Deployment Options

### Option 1: Render.com (FREE - Recommended for Testing)

**Pros:**
- ✅ Free tier available
- ✅ Auto-deploys from GitHub
- ✅ Easy setup

**Cons:**
- ⚠️ Sleeps after 15 min of inactivity (cold start ~30 seconds)
- ⚠️ Slower performance on free tier

**Steps:**
1. Push code to GitHub
2. Go to [render.com](https://render.com) → Sign up
3. New Web Service → Connect GitHub repo
4. Settings:
   - **Name**: robinhood-pnl-server
   - **Root Directory**: server
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Click "Create Web Service"
6. Copy the URL (e.g., `https://robinhood-pnl-server.onrender.com`)
7. Update `.env.local`:
   ```
   VITE_SERVER_URL=https://robinhood-pnl-server.onrender.com
   ```

---

### Option 2: Railway.app ($5/month - Recommended for Production)

**Pros:**
- ✅ Always on (no sleep)
- ✅ Fast performance
- ✅ Auto-deploys from GitHub
- ✅ $5 credit/month included

**Cons:**
- 💰 Costs $5/month after free credit

**Steps:**
1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → Sign up
3. New Project → Deploy from GitHub
4. Select your repo
5. Settings:
   - **Root Directory**: server
   - **Start Command**: npm start
6. Deploy
7. Get the URL from Railway dashboard
8. Update `.env.local`:
   ```
   VITE_SERVER_URL=https://your-app.up.railway.app
   ```

---

### Option 3: Fly.io (FREE)

**Pros:**
- ✅ Generous free tier (3 VMs)
- ✅ Always on
- ✅ Good performance

**Cons:**
- ⚠️ Slightly more complex setup

**Steps:**
1. Install flyctl:
   ```bash
   # Windows (PowerShell)
   iwr https://fly.io/install.ps1 -useb | iex
   ```

2. Login:
   ```bash
   flyctl auth login
   ```

3. Launch app:
   ```bash
   cd server
   flyctl launch
   ```
   - App name: robinhood-pnl-server
   - Region: Choose closest to you
   - PostgreSQL: No
   - Redis: No

4. Deploy:
   ```bash
   flyctl deploy
   ```

5. Get URL:
   ```bash
   flyctl status
   ```

6. Update `.env.local`:
   ```
   VITE_SERVER_URL=https://robinhood-pnl-server.fly.dev
   ```

---

## Frontend Deployment (After Server is Deployed)

### Option A: Vercel (Recommended)
1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → Import project
3. Add environment variable:
   - `VITE_SERVER_URL` = your server URL
4. Deploy!

### Option B: Netlify
1. Push to GitHub
2. Go to [netlify.com](https://netlify.com) → New site from Git
3. Build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Environment variables:
   - `VITE_SERVER_URL` = your server URL
5. Deploy!

---

## Testing Multi-Client

### Local Testing:
1. Open browser window 1: http://localhost:5173
2. Open browser window 2: http://localhost:5173  (incognito)
3. Upload CSV in window 1
4. Both should see real-time price updates!

### Production Testing:
1. Open your deployed frontend in 2+ browsers/devices
2. Upload CSV in one
3. All should receive price updates automatically

---

## Monitoring & Logs

### Render.com
- Dashboard → Your Service → Logs tab
- Real-time logs

### Railway
- Dashboard → Your Project → Deployments → View Logs
- Real-time logs

### Fly.io
```bash
flyctl logs
```

---

## Troubleshooting

### Server won't start locally
**Problem**: Port 3001 already in use
**Solution**:
```bash
# Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

### WebSocket connection fails
**Problem**: CORS error or connection refused
**Solution**:
1. Check server is running: http://localhost:3001/health
2. Check `.env.local` has correct URL
3. Check browser console for errors

### Cold starts on Render
**Problem**: First request takes 30+ seconds
**Solution**:
- Upgrade to paid plan ($7/month) for always-on
- OR use Railway/Fly.io instead

### Price updates not working
**Problem**: Clients not receiving updates
**Solution**:
1. Check server logs for errors
2. Verify WebSocket connection in browser console
3. Check Yahoo Finance API is accessible

---

## Cost Comparison

| Service | Cost | Performance | Ease |
|---------|------|-------------|------|
| **Render Free** | $0 | ⭐⭐ (sleeps) | ⭐⭐⭐⭐⭐ |
| **Render Paid** | $7/mo | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Railway** | $5/mo | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Fly.io Free** | $0 | ⭐⭐⭐⭐ | ⭐⭐⭐ |

**Recommendation**:
- **Testing**: Render.com (free)
- **Production**: Railway.app ($5/mo)

---

## Next Steps

### Immediate (Local Testing)
- [ ] Server running at http://localhost:3001 ✓
- [ ] Frontend connected (check console)
- [ ] Test CSV upload
- [ ] Test real-time price updates
- [ ] Test with multiple browser windows

### Short Term (Deployment)
- [ ] Push code to GitHub
- [ ] Deploy server to Render/Railway/Fly
- [ ] Deploy frontend to Vercel/Netlify
- [ ] Test with real clients

### Long Term (Optional)
- [ ] Add user authentication
- [ ] Add database for persistence
- [ ] Add monitoring/alerts
- [ ] Custom domain name

---

## Support

- **Server Issues**: Check `server/README.md`
- **Deployment Issues**: Check hosting provider docs
- **WebSocket Issues**: Check browser console + server logs

Ready to deploy? Pick a hosting service above and follow the steps!
