# Railway Deployment Guide

This project deploys both a **client (frontend)** and **server (backend)** to Railway as separate services.

## Architecture

- **Client Service**: Vite React app served via `vite preview`
- **Server Service**: Node.js Express + Socket.IO backend with SQLite database
- Both services run in Docker containers with Node 20

## Railway Services Setup

### Service 1: Server (Backend)

**Required Settings:**
1. **Root Directory**: `server`
2. **Environment Variables**:
   - `PORT`: `8080` (or let Railway auto-assign)
   - `RAILWAY_DOCKERFILE_PATH`: `server/Dockerfile`
3. **Custom Start Command**: Leave empty (uses Dockerfile CMD)

**Important Files:**
- `server/Dockerfile` - Uses Node 20 Alpine with Python for better-sqlite3
- `server/package.json` - Server dependencies
- `server/railway.json` - Deployment configuration (restart policy)

**Build Process:**
- Railway uses `server/Dockerfile`
- Installs Python and build tools for native dependencies (better-sqlite3)
- Copies files from `server/` directory
- Runs: `node --max-old-space-size=512 index.js`

**URL Pattern**: `https://robinhood-pnl-tracker-production-XXXX.up.railway.app`

---

### Service 2: Client (Frontend)

**Required Settings:**
1. **Root Directory**: Leave empty (uses root `/`)
2. **Environment Variables**:
   - `PORT`: `8080` (or let Railway auto-assign)
   - `VITE_SERVER_URL`: `https://robinhood-pnl-tracker-production-XXXX.up.railway.app` (server URL)
3. **Custom Start Command**: Leave empty (uses Dockerfile CMD)

**Important Files:**
- `Dockerfile` (root) - Uses Node 20 Alpine
- `package.json` (root) - Client dependencies
- `railway.toml` (root) - Deployment configuration (restart policy)

**Build Process:**
- Railway uses root `Dockerfile`
- Runs `npm install` and `npm run build`
- Serves built files with: `vite preview --port ${PORT} --host 0.0.0.0`

**URL Pattern**: `https://robinhood-pnl-tracker-production.up.railway.app`

---

## Key Configuration Details

### Why Two Dockerfiles?

1. **Server Dockerfile** (`server/Dockerfile`):
   - Needs Python + build tools for `better-sqlite3` native compilation
   - Copies from `server/` subdirectory
   - Runs Node server directly

2. **Client Dockerfile** (root `Dockerfile`):
   - Standard Vite build process
   - Serves static files with vite preview

### Why Root Directory Setting?

Railway's build context is always the repository root. The Root Directory setting tells Railway which subdirectory contains the service code:
- **Server**: Root Directory = `server` → looks for `server/Dockerfile`, `server/package.json`
- **Client**: Root Directory = (empty) → looks for root `Dockerfile`, root `package.json`

### Environment Variables

**VITE_SERVER_URL**:
- Must be set at **build time** for the client
- Vite bakes environment variables into the build
- Format: `https://your-server-url.railway.app` (no trailing slash)

**RAILWAY_DOCKERFILE_PATH**:
- Tells Railway which Dockerfile to use
- Server: `server/Dockerfile`
- Client: Uses default (root `Dockerfile`)

---

## Common Issues & Solutions

### Issue: Server tries to run vite command
**Solution**: Clear "Custom Start Command" in Railway server service settings. The Dockerfile has the correct CMD.

### Issue: `Cannot find module '/app/index.js'`
**Solution**: Make sure server Dockerfile copies from `server/` directory: `COPY server/ .`

### Issue: `better-sqlite3` build fails
**Solution**:
- Use Node 20+ (better-sqlite3 requirement)
- Install Python and build tools: `RUN apk add --no-cache python3 make g++`

### Issue: Client shows "not connected to server"
**Solution**:
- Set `VITE_SERVER_URL` environment variable in Railway client service
- Ensure it points to the correct server URL
- Check server CORS configuration allows the client origin

### Issue: CORS errors
**Solution**: Server has CORS configured to allow all origins (`origin: '*'`). If issues persist:
- Check server logs for startup errors
- Verify Socket.IO CORS configuration in `server/index.js`
- Ensure both services are deployed and running

---

## Deployment Checklist

When deploying updates:

**Server:**
- [ ] Commit and push changes
- [ ] Verify `server/Dockerfile` is correct
- [ ] Check Railway server service uses Root Directory = `server`
- [ ] Verify `RAILWAY_DOCKERFILE_PATH=server/Dockerfile`
- [ ] Monitor build logs for Python/better-sqlite3 compilation
- [ ] Check server starts: "Server running on 0.0.0.0:8080"

**Client:**
- [ ] Commit and push changes
- [ ] Verify root `Dockerfile` is correct
- [ ] Check Railway client service Root Directory is empty
- [ ] Verify `VITE_SERVER_URL` is set correctly
- [ ] Monitor build logs for Vite build completion
- [ ] Test client connects to server (check browser console)

---

## Local Development

**Server:**
```bash
cd server
npm install
npm start
# Runs on http://localhost:3001
```

**Client:**
```bash
npm install
npm run dev
# Runs on http://localhost:5173
```

The client will connect to `http://localhost:3001` when running locally (auto-detected by `socketService.js`).

---

## File Structure

```
robinhood-pnl-tracker/
├── Dockerfile                 # Client Dockerfile (Node 20)
├── railway.toml              # Client Railway config
├── package.json              # Client dependencies
├── src/                      # Client source code
│   └── services/
│       └── socketService.js  # Auto-detects server URL
├── server/
│   ├── Dockerfile           # Server Dockerfile (Node 20 + Python)
│   ├── railway.json         # Server Railway config
│   ├── package.json         # Server dependencies
│   ├── index.js            # Express + Socket.IO server
│   └── services/           # Server business logic
└── RAILWAY_DEPLOYMENT.md   # This file
```

---

## Troubleshooting Commands

**Check Railway deployment:**
```bash
# View logs in Railway dashboard
# Server logs: Look for "Server running on 0.0.0.0:8080"
# Client logs: Look for "preview server running at"
```

**Test server directly:**
```bash
curl https://your-server-url.railway.app/health
# Should return JSON with status and uptime
```

**Test Socket.IO connection:**
- Open client in browser
- Open DevTools Console (F12)
- Look for: "Connected to server at https://..."
- Should see: "✅ Connected to server: <socket-id>"

---

## Last Working Configuration (2025-12-07)

- Node version: 20.19.6
- Railway builder: Docker (Nixpacks deprecated)
- Server port: 8080
- Client port: 8080
- Both services running in separate Railway deployments
- Socket.IO using default transports (polling + WebSocket)
- CORS: Configured to allow all origins

---

## Notes

- Railway automatically provides `PORT` environment variable
- Both Dockerfiles use `${PORT:-8080}` for fallback
- Server uses `0.0.0.0` to listen on all interfaces (required for Railway)
- Client auto-detects production vs localhost for server URL
- Split adjustments and manual prices stored in-memory per session
