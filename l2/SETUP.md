# IB Gateway setup — Level 2 depth

You don't need to send me anything. No credentials, no keys. You just need
IB Gateway running on this machine; it listens on 127.0.0.1 and the script
connects to that local socket.

## Steps

### 1. Get IB Gateway
Download "IB Gateway — Stable" from IBKR. Lighter than TWS, built for this.
TWS works too if you already have it.

### 2. Log in
Your credentials, your machine. Use the **live** login, not paper —
paper sessions don't carry real market data entitlements.

### 3. Enable the API
Configure -> Settings -> API -> Settings:

- [x] **Enable ActiveX and Socket Clients**
- [x] **Read-Only API**  <- tick this. We only read data, and it makes it
      structurally impossible for anything here to place an order.
- **Trusted IPs**: add `127.0.0.1`
- Note the **Socket port** (usually `4001` for live Gateway)

### 4. Log out of the IBKR mobile app
IBKR allows one live market data session at a time. If the phone app is
open you get error `10197 No market data during competing live session`,
and depth looks broken when it isn't.

### 5. Run the preflight

```
cd Documents/robinhood-pnl-tracker/l2
.venv/Scripts/python preflight.py NVDA
```

Paste me the output. It reports which books you're entitled to, how many
levels deep, and whether the trade tape is flowing.

Run it during market hours (9:30-16:00 ET). Outside those hours a quiet
book and a missing entitlement look identical.

## If it fails

**Errors 354 or 10089** — subscriptions sometimes don't activate until the
next session. If you added TotalView this morning it may not be live until
tomorrow. That's "wait a day," not "broken."

**Check your non-professional certification** in Client Portal. If it
lapsed, IBKR reclassifies you and the entitlement changes.

**Check the subscription actually went through.** Client Portal -> Settings
-> Market Data Subscriptions should list **NASDAQ TotalView-OpenView** as
its own line, not just the Streaming Bundle. If you only see the bundle,
the depth add-on didn't take.

## What happens next

Once the preflight is green I wire the recorder to the feed.

Meanwhile I'm building the absorption engine — the consumed-vs-pulled math
and the schema don't depend on the feed, so that work is good regardless of
which books you end up with.
