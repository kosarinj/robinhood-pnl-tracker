"""How wide a price range does our depth subscription actually cover?"""
import sys
from ib_async import IB, Stock
sym, rows = sys.argv[1].upper(), int(sys.argv[2])
ib = IB(); ib.connect("127.0.0.1", 4001, clientId=93, timeout=8, readonly=True)
c = ib.qualifyContracts(Stock(sym, "SMART", "USD"))[0]
t = ib.reqMktDepth(c, numRows=rows, isSmartDepth=True)
ib.sleep(6)
b = [(r.price, r.size) for r in t.domBids]
a = [(r.price, r.size) for r in t.domAsks]
if b and a:
    print(f"{sym}: {len(b)} bid / {len(a)} ask levels")
    print(f"  bids  {b[-1][0]:.2f} .. {b[0][0]:.2f}")
    print(f"  asks  {a[0][0]:.2f} .. {a[-1][0]:.2f}")
    span = a[-1][0] - b[-1][0]
    mid = (b[0][0] + a[0][0]) / 2
    print(f"  total span {span:.2f} = {span/mid*100:.2f}% of price")
    print(f"  largest bid size {max(x[1] for x in b):.0f}, largest ask {max(x[1] for x in a):.0f}")
else:
    print("no depth returned")
ib.cancelMktDepth(c, isSmartDepth=True); ib.disconnect()
