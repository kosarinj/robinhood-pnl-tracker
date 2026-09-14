"""
What does this name's book actually look like?

Thresholds decide what counts as a wall, and a number picked in the abstract is
just a guess. This watches for a while and reports the distribution, so the
figures come from the book rather than from an idea of what a book contains.
"""
import argparse, statistics, sys
from datetime import datetime
from ib_async import IB, Stock
from engine import AbsorptionEngine, Aggressor, Side, Thresholds

ap = argparse.ArgumentParser()
ap.add_argument("symbol"); ap.add_argument("--port", type=int, default=4001)
ap.add_argument("--client-id", type=int, default=86)
ap.add_argument("--seconds", type=int, default=60)
a = ap.parse_args()

ib = IB(); ib.connect("127.0.0.1", a.port, clientId=a.client_id, timeout=8, readonly=True)
sym = a.symbol.upper()
eng = AbsorptionEngine(sym, thresholds=Thresholds(min_track_size=0))
c = ib.qualifyContracts(Stock(sym, "SMART", "USD"))[0]
bid = ask = None
sizes = []

def on_tick(t):
    global bid, ask
    now = datetime.now().timestamp()
    for x in t.tickByTicks:
        if hasattr(x, "bidPrice"): bid, ask = x.bidPrice, x.askPrice
        elif hasattr(x, "size"):
            agg = Aggressor.BUY if ask and x.price >= ask else (
                  Aggressor.SELL if bid and x.price <= bid else Aggressor.UNKNOWN)
            eng.on_trade(x.price, float(x.size), now, agg)

def on_depth(t):
    now = datetime.now().timestamp()
    for side, rows in ((Side.BID, t.domBids), (Side.ASK, t.domAsks)):
        for r in rows:
            sizes.append(float(r.size))
            eng.on_book(side, r.price, float(r.size), now)

d = ib.reqMktDepth(c, numRows=10, isSmartDepth=True); d.updateEvent += on_depth
tp = ib.reqTickByTickData(c, "AllLast", 0, False)
q = ib.reqTickByTickData(c, "BidAsk", 0, False)
for t in {id(tp): tp, id(q): q}.values(): t.updateEvent += on_tick

print(f"Sampling {sym} for {a.seconds}s...")
ib.sleep(a.seconds)

def pct(vals, p):
    if not vals: return 0
    s = sorted(vals); return s[min(len(s) - 1, int(len(s) * p / 100))]

consumed = [l.consumed for l in eng.levels.values() if l.consumed > 0]
shown = [l.max_displayed for l in eng.levels.values() if l.max_displayed > 0]

print(f"\n  depth rows seen : {len(sizes)}")
print(f"  displayed size  : median {pct(sizes,50):.0f}  p90 {pct(sizes,90):.0f}  max {max(sizes or [0]):.0f}")
print(f"  level max shown : median {pct(shown,50):.0f}  p90 {pct(shown,90):.0f}  max {max(shown or [0]):.0f}")
print(f"  level consumed  : median {pct(consumed,50):.0f}  p90 {pct(consumed,90):.0f}  max {max(consumed or [0]):.0f}")
print(f"  levels touched  : {len(eng.levels)}")

wall = max(500, pct(shown, 90) * 2)
print(f"\n  suggested for a {a.seconds}s sample (scale up for a full session):")
print(f"    min_wall_size       {wall:.0f}")
print(f"    min_absorbed_volume {wall*2.5:.0f}")
print(f"    min_track_size      {wall*0.2:.0f}")

ib.cancelMktDepth(c, isSmartDepth=True); ib.disconnect()
