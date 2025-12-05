# Railway.app Deployment Guide

## 🚀 Deploy Your Server to Railway.app

Railway.app is the recommended hosting for your WebSocket server because:
- ✅ Always on (no sleeping)
- ✅ Excellent performance
- ✅ $5/month with $5 free credit included
- ✅ Auto-deploys from GitHub
- ✅ Very easy setup

---

## Step 1: Prepare Your Code

### 1.1 Check Git Status

```bash
cd C:\Users\jeffk\Documents\robinhood-pnl-tracker
git status
```

**If you haven't initialized git yet:**
```bash
git init
git add .
git commit -m "Initial commit - P&L tracker with WebSocket server"
```

### 1.2 Create GitHub Repository

1. Go to [github.com](https://github.com) → Sign in
2. Click the "+" icon → "New repository"
3. Repository name: `robinhood-pnl-tracker`
4. Description: "Robinhood P&L Tracker with real-time WebSocket server"
5. Choose: **Private** (recommended for your trading data)
6. Click "Create repository"

### 1.3 Push to GitHub

```bash
# Add the remote
git remote add origin https://github.com/YOUR_USERNAME/robinhood-pnl-tracker.git

# Push your code
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy Server to Railway

### 2.1 Sign Up for Railway

1. Go to [railway.app](https://railway.app)
2. Click "Login" → "Login with GitHub"
3. Authorize Railway to access your GitHub

### 2.2 Create New Project

1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose your repository: `robinhood-pnl-tracker`
4. Railway will detect it's a Node.js project

### 2.3 Configure the Server Service

Railway should auto-detect the server, but let's verify:

1. Click on your deployment
2. Go to "Settings" tab
3. Check these settings:
   - **Root Directory**: `server` (IMPORTANT!)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Click "Save Changes"

### 2.4 Set Environment Variables (Optional)

If you need environment variables:

1. Go to "Variables" tab
2. Add any needed variables:
   - `NODE_ENV` = `production`
   - `PORT` = `3001` (Railway will override this, but good to have)

### 2.5 Deploy

1. Railway will automatically deploy
2. Watch the build logs in the "Deployments" tab
3. Wait for "Build successful" message (usually 1-2 minutes)

### 2.6 Get Your Server URL

1. Go to "Settings" tab
2. Scroll to "Domains" section
3. Click "Generate Domain"
4. Copy your URL (e.g., `https://robinhood-pnl-server-production.up.railway.app`)

**Your server is now live!** 🎉

---

## Step 3: Update Frontend Configuration

### 3.1 Update .env.local

Open `.env.local` and update the server URL:

```env
# Production server on Railway
VITE_SERVER_URL=https://robinhood-pnl-server-production.up.railway.app
```

**Replace with your actual Railway URL from Step 2.6**

### 3.2 Test Locally with Production Server

```bash
# Restart frontend dev server
npm run dev
```

1. Open http://localhost:5175
2. Check connection status - should show green "Connected to server"
3. Upload CSV
4. Verify everything works

---

## Step 4: Deploy Frontend to Vercel (FREE)

### 4.1 Sign Up for Vercel

1. Go to [vercel.com](https://vercel.com)
2. Click "Sign Up" → "Continue with GitHub"
3. Authorize Vercel

### 4.2 Import Project

1. Click "Add New..." → "Project"
2. Import `robinhood-pnl-tracker` from GitHub
3. Vercel detects Vite automatically

### 4.3 Configure Build Settings

**Framework Preset**: Vite
**Root Directory**: `.` (leave as root)
**Build Command**: `npm run build`
**Output Directory**: `dist`

### 4.4 Set Environment Variables

**CRITICAL STEP:**

1. Expand "Environment Variables"
2. Add:
   - **Key**: `VITE_SERVER_URL`
   - **Value**: Your Railway server URL (e.g., `https://robinhood-pnl-server-production.up.railway.app`)
3. Click "Add"

### 4.5 Deploy

1. Click "Deploy"
2. Wait for build to complete (1-2 minutes)
3. Get your URL (e.g., `https://robinhood-pnl-tracker.vercel.app`)

**Your frontend is now live!** 🎉

---

## Step 5: Test Production Deployment

### 5.1 Test Server Health

Open in browser:
```
https://your-railway-url.up.railway.app/health
```

Should see:
```json
{
  "status": "healthy",
  "clients": 0,
  "trackedSymbols": 0,
  "uptime": 12.5
}
```

### 5.2 Test Frontend Connection

1. Open your Vercel URL: `https://robinhood-pnl-tracker.vercel.app`
2. Check for green connection indicator
3. Upload CSV file
4. Verify real-time price updates work
5. Test Trading Signals

### 5.3 Test Multi-Client

1. Open production URL in two different browsers/devices
2. Upload CSV in one
3. Both should receive price updates every minute

---

## Step 6: Monitor Your Deployment

### Railway Monitoring

1. Go to Railway dashboard
2. Click your project
3. View:
   - **Deployments**: See build history
   - **Metrics**: CPU, Memory, Network usage
   - **Logs**: Real-time server logs

### View Server Logs

1. Go to Railway project
2. Click on your service
3. Click "View Logs" tab
4. Watch real-time:
   ```
   🚀 Server running on port 3001
   Client connected: xyz123
   Refreshing prices for 64 symbols...
   ```

---

## 💰 Cost Breakdown

### Railway Server
- **Cost**: $5/month
- **Includes**: $5 free credit/month
- **Effective Cost**: ~$0 (credit covers usage)
- **What you get**:
  - Always-on server
  - WebSocket support
  - Auto-deploy from GitHub
  - SSL/HTTPS included

### Vercel Frontend
- **Cost**: FREE
- **Includes**:
  - Unlimited deployments
  - Auto-deploy from GitHub
  - Global CDN
  - SSL/HTTPS included

**Total Monthly Cost: ~$0** (Railway credit covers server)

---

## 🔄 Auto-Deploy Setup

### How It Works

Once deployed, any changes you push to GitHub automatically deploy:

```bash
# Make changes to your code
git add .
git commit -m "Update trading signals logic"
git push

# Railway and Vercel automatically:
# 1. Detect the push
# 2. Build the new version
# 3. Deploy to production
# 4. Zero downtime!
```

### Enable Auto-Deploy

**Railway**: Already enabled by default ✅
**Vercel**: Already enabled by default ✅

---

## 🔧 Troubleshooting

### Server Not Responding

**Problem**: Can't connect to Railway server

**Check**:
1. Railway deployment status - should be "Success"
2. Railway logs - check for errors
3. Server URL in frontend `.env.local` is correct
4. HTTPS (not HTTP) in the URL

**Solution**:
```bash
# Check Railway logs
# Go to Railway dashboard → Logs tab
# Look for startup message: "🚀 Server running on port..."
```

### Frontend Can't Connect

**Problem**: Frontend shows red "Not connected"

**Check**:
1. Browser console for errors (F12 → Console)
2. Verify `VITE_SERVER_URL` environment variable in Vercel
3. Check if server URL is accessible
4. CORS might be blocking - server allows all origins by default

**Solution**:
1. Go to Vercel → Project Settings → Environment Variables
2. Verify `VITE_SERVER_URL` is set correctly
3. Redeploy frontend

### CSV Upload Fails

**Problem**: CSV upload shows error

**Check**:
1. Railway logs for error messages
2. CSV file format matches Robinhood export
3. Server has enough memory (Railway shows metrics)

**Solution**:
- Check Railway logs for specific error
- Verify CSV has required columns
- Try smaller CSV file first

### Price Updates Not Working

**Problem**: Prices not updating every minute

**Check**:
1. Railway logs - should show "Refreshing prices..." every minute
2. Yahoo Finance API accessible from Railway servers
3. WebSocket connection active

**Solution**:
- Check Railway logs for API errors
- Verify client stays connected (check browser console)
- Railway free tier has no issues with WebSockets ✅

---

## 🎯 Success Checklist

### Server Deployment
- [ ] Code pushed to GitHub
- [ ] Railway project created
- [ ] Server deployed successfully
- [ ] Health endpoint accessible
- [ ] Domain generated and copied

### Frontend Deployment
- [ ] `.env.local` updated with Railway URL
- [ ] Tested locally with production server
- [ ] Vercel project created
- [ ] Environment variable set in Vercel
- [ ] Frontend deployed successfully
- [ ] Connection shows green indicator

### Production Testing
- [ ] CSV upload works
- [ ] Real-time price updates every minute
- [ ] Trading signals generate
- [ ] Symbol lookup works
- [ ] Multi-client tested (2+ browsers)
- [ ] Mobile device tested

### Monitoring
- [ ] Railway dashboard bookmarked
- [ ] Vercel dashboard bookmarked
- [ ] Server logs reviewed
- [ ] No errors in production

---

## 🚀 You're Live!

### What You Now Have

✅ **Professional Production Setup**:
- Always-on WebSocket server
- Real-time price updates
- Trading signals on-demand
- Multi-client support
- Auto-deploy from GitHub
- Free hosting (Railway credit covers server)
- SSL/HTTPS everywhere
- Global CDN (Vercel)

### Share Your App

You can now share your Vercel URL with anyone:
```
https://robinhood-pnl-tracker.vercel.app
```

- No installation needed
- Works on any device
- Real-time updates for all users
- Professional quality

---

## 📚 Next Steps (Optional)

### Add Custom Domain
1. Buy domain (e.g., `mytrading.app`)
2. Add to Vercel: Settings → Domains
3. Update DNS records
4. SSL auto-configured

### Add Authentication
- Implement user login
- Secure CSV uploads
- Private portfolios

### Add Database
- Railway offers PostgreSQL
- Store historical data
- Track performance over time

### Add Monitoring
- Set up error tracking (Sentry)
- Add analytics (Plausible)
- Email alerts for server issues

---

## 🎉 Congratulations!

Your Robinhood P&L Tracker is now:
- ✅ Deployed to production
- ✅ Accessible from anywhere
- ✅ Auto-updating prices
- ✅ Supporting multiple clients
- ✅ Professional quality
- ✅ Costs ~$0/month

Enjoy your real-time trading insights! 📈
