# Railway Deployment Fix Guide

## Problem: "Not connected to server" message when deployed

### Diagnosis Steps

1. **Check if the server is actually running on Railway:**
   - Go to [railway.app](https://railway.app)
   - Open your project
   - Check the "Deployments" tab
   - Look for build success or errors

2. **Check Server Logs:**
   - In Railway dashboard → Click on your service
   - Go to "View Logs" tab
   - Look for `🚀 Server running on port...` message
   - If you don't see this, the server isn't starting

### Common Issues & Solutions

#### Issue #1: Railway is building/deploying the wrong directory

**Symptom:** Build succeeds but server doesn't start, or you see frontend files being built instead of the server.

**Fix:**
1. Go to Railway dashboard → Your project → Settings
2. Scroll to "Service Settings"
3. Set **Root Directory** to: `server`
4. Set **Start Command** to: `node index.js`
5. Save and redeploy

#### Issue #2: No server deployment at all

**Symptom:** Only one service in Railway (the frontend)

**Fix:** You need to deploy the server separately:

1. In Railway dashboard, click "New"
2. Select "Deploy from GitHub repo"
3. Choose your repository again
4. This time, configure it for the server:
   - **Root Directory:** `server`
   - **Start Command:** `node index.js`
5. After deployment, generate a domain:
   - Settings → Domains → Generate Domain
   - Copy this URL (e.g., `https://YOUR-SERVER.up.railway.app`)

#### Issue #3: Frontend doesn't know the server URL

**Symptom:** Server is running but frontend shows "Not connected"

**Fix:**

If you deployed the **frontend** to Railway (or Vercel):
1. Go to your frontend deployment settings
2. Add environment variable:
   - **Key:** `VITE_SERVER_URL`
   - **Value:** Your server URL from Railway (e.g., `https://your-server.up.railway.app`)
3. Redeploy the frontend

If running **locally**:
1. Update `.env.local`:
   ```env
   VITE_SERVER_URL=https://your-actual-railway-server-url.up.railway.app
   ```
2. Restart dev server: `npm run dev`

#### Issue #4: Server deployed but crashed

**Symptom:** In Railway logs, you see errors like "Cannot find module" or other startup errors

**Fix:**
1. Check Railway logs for specific error
2. Common issues:
   - Missing dependencies → Check `server/package.json`
   - Wrong Node version → Railway uses latest, should be fine
   - Import errors → Make sure all service files exist

#### Issue #5: CORS or WebSocket connection blocked

**Symptom:** Server running, frontend shows connection errors in browser console (F12)

**Fix:**
- The server already has CORS enabled for all origins (line 14-17 in server/index.js)
- Check browser console (F12) for specific errors
- WebSocket should work on Railway by default

### Quick Test: Is Your Server Running?

Open this URL in your browser (replace with your actual Railway server URL):
```
https://YOUR-SERVER-URL.up.railway.app/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "clients": 0,
  "trackedSymbols": 0,
  "uptime": 12.5
}
```

If you get this response, your server is running! The issue is with the frontend configuration.

If you get a 404 or timeout, your server isn't running properly.

### Recommended Railway Setup

For best results, you should have **TWO Railway services**:

1. **Server Service:**
   - Root Directory: `server`
   - Start Command: `node index.js`
   - Generate a domain
   - This runs 24/7

2. **Frontend Service (Optional):**
   - Root Directory: `.` (root)
   - Build Command: `npm run build`
   - Start Command: `npx serve -s dist`
   - Environment Variable: `VITE_SERVER_URL=https://your-server.up.railway.app`

**OR** deploy frontend to Vercel (FREE) and server to Railway - this is the recommended approach from RAILWAY_DEPLOY.md.

### Still Not Working?

1. **Check Railway service status:**
   - Does it say "Active" or "Failed"?
   - Check the Metrics tab for CPU/Memory usage

2. **Check the actual URL:**
   - Make sure the URL in `.env.local` matches your Railway domain exactly
   - Must be HTTPS, not HTTP
   - No trailing slash

3. **Test server health endpoint:**
   ```bash
   curl https://YOUR-SERVER-URL.up.railway.app/health
   ```

4. **Check browser console (F12):**
   - Look for WebSocket connection errors
   - Look for CORS errors
   - Copy any error messages

### Current Configuration Check

Your current `.env.local` has:
```
VITE_SERVER_URL=https://robinhood-pnl-tracker-production.up.railway.app
```

**Test this URL:**
1. Open: `https://robinhood-pnl-tracker-production.up.railway.app/health`
2. If this doesn't work, the server isn't running at this URL
3. Check your Railway dashboard for the actual service URL

### Environment Variables to Set

**On Railway (Server):**
- `NODE_ENV=production` (optional)
- `PORT=3001` (optional, Railway auto-assigns)

**On Frontend (Railway/Vercel/Local):**
- `VITE_SERVER_URL=https://your-actual-server-url.up.railway.app`

### Debug Mode

To see what's happening, check browser console (F12) when you load the app. You should see:
```
Connecting to server at https://...
✅ Connected to server: <socket-id>
```

If you see:
```
Connection error: ...
```

Then there's a connection issue - check the URL and server status.

---

## Next Steps

1. Go to Railway dashboard
2. Find your server service (or create one if missing)
3. Verify Root Directory = `server`
4. Check logs for "🚀 Server running on port..."
5. Test the `/health` endpoint
6. Update frontend `VITE_SERVER_URL` if needed
7. Redeploy and test

Need more help? Check the Railway logs and browser console for specific errors.
