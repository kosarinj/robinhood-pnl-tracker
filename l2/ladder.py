import sys
from ib_async import IB, Stock
sym = sys.argv[1].upper()
ib = IB(); ib.connect("127.0.0.1", 4001, clientId=94, timeout=8, readonly=True)
c = ib.qualifyContracts(Stock(sym, "SMART", "USD"))[0]
t = ib.reqMktDepth(c, numRows=30, isSmartDepth=True)
ib.sleep(7)
print(f"{sym} full ladder (SMART aggregated depth)")
print("  ASKS")
for r in sorted(t.domAsks, key=lambda r: -r.price):
    print(f"    {r.price:8.2f}  {r.size:>6.0f}  {getattr(r,'marketMaker','')}")
print("  BIDS")
for r in sorted(t.domBids, key=lambda r: -r.price):
    print(f"    {r.price:8.2f}  {r.size:>6.0f}  {getattr(r,'marketMaker','')}")
ib.cancelMktDepth(c, isSmartDepth=True); ib.disconnect()
