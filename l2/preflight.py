"""
Does this IBKR account actually have Level 2 depth?

Run this before anything else is built on top of the feed. It answers three
questions that cannot be answered from the subscription page, because the page
lists product names and the API cares about entitlements:

  1. Can we reach IB Gateway / TWS at all?
  2. Does reqMktDepth return a book, or an entitlement error?
  3. Does tick-by-tick return trades, and do we have to infer the aggressor?

Depth is the gate. The Value Bundle and the US Equity and Options Add-On
Streaming Bundle are both Level 1 — top of book only — and neither one makes
reqMktDepth work. Depth needs NASDAQ TotalView-OpenView for Nasdaq-listed names
or NYSE OpenBook / ArcaBook for NYSE-listed ones.

Usage:
    .venv/Scripts/python preflight.py NVDA
    .venv/Scripts/python preflight.py NVDA AAPL --port 7496
"""

import argparse
import sys
import time
from collections import defaultdict

from ib_async import IB, Stock, util

# TWS and Gateway listen on different ports, live and paper differ again, and
# people rarely remember which one they left running. Try them in the order
# most likely to be a real trading setup.
CANDIDATE_PORTS = [
    (4001, "IB Gateway (live)"),
    (7496, "TWS (live)"),
    (4002, "IB Gateway (paper)"),
    (7497, "TWS (paper)"),
]

# Errors that mean "you are not entitled", as opposed to a transient problem.
# IBKR reports entitlement failures as ordinary errors on the request, so
# without this list a missing subscription looks like an empty book.
ENTITLEMENT_CODES = {
    354: "Requested market data is not subscribed",
    10089: "Requires additional market data subscription",
    10197: "No market data during competing live session",
    2152: "Market depth data is not supported for this combination",
}
# Informational notices IBKR sends on every connection. Not failures.
NOISE_CODES = {2104, 2106, 2107, 2108, 2119, 2158, 2100, 2150}


class ErrorLog:
    """Collects IBKR errors per request id so each probe can report its own."""

    def __init__(self, ib):
        self.by_req = defaultdict(list)
        self.general = []
        ib.errorEvent += self._on_error

    def _on_error(self, reqId, errorCode, errorString, contract):
        if errorCode in NOISE_CODES:
            return
        entry = (errorCode, errorString)
        if reqId and reqId > 0:
            self.by_req[reqId].append(entry)
        else:
            self.general.append(entry)

    def for_req(self, reqId):
        return self.by_req.get(reqId, [])


def connect(port_arg, client_id):
    ib = IB()
    ports = [(port_arg, f"port {port_arg}")] if port_arg else CANDIDATE_PORTS
    for port, label in ports:
        try:
            ib.connect("127.0.0.1", port, clientId=client_id, timeout=6)
            print(f"  connected: {label} on 127.0.0.1:{port}")
            return ib, port
        except Exception as e:
            print(f"  no answer on {port:>5} ({label}) -- {type(e).__name__}")
    return None, None


def probe_depth(ib, errors, symbol, exchange, smart):
    """One depth request. Returns (rows_seen, [errors])."""
    contract = Stock(symbol, exchange, "USD")
    try:
        qualified = ib.qualifyContracts(contract)
        if not qualified:
            return 0, [(0, f"could not qualify {symbol} on {exchange}")]
        contract = qualified[0]
    except Exception as e:
        return 0, [(0, f"qualify failed: {e}")]

    try:
        ticker = ib.reqMktDepth(contract, numRows=10, isSmartDepth=smart)
    except Exception as e:
        return 0, [(0, f"reqMktDepth raised: {e}")]

    req_id = getattr(ticker, "reqId", None) or 0
    # Depth arrives as a stream of insert/update/delete rows. Give it a few
    # seconds: outside market hours a real entitlement can still be quiet.
    deadline = time.time() + 6
    while time.time() < deadline:
        ib.sleep(0.25)
        if ticker.domBids or ticker.domAsks:
            break

    rows = len(ticker.domBids) + len(ticker.domAsks)
    found = errors.for_req(req_id) if req_id else []
    if not found:
        # reqId is not always exposed on the ticker; fall back to anything new.
        found = [e for lst in errors.by_req.values() for e in lst]

    try:
        ib.cancelMktDepth(contract, isSmartDepth=smart)
    except Exception:
        pass

    return rows, found, ticker


def probe_ticks(ib, errors, symbol):
    contract = Stock(symbol, "SMART", "USD")
    qualified = ib.qualifyContracts(contract)
    if not qualified:
        return None
    contract = qualified[0]

    trades = ib.reqTickByTickData(contract, "AllLast", 0, False)
    quotes = ib.reqTickByTickData(contract, "BidAsk", 0, False)
    ib.sleep(5)

    n_trades = len(trades.tickByTicks) if trades else 0
    n_quotes = len(quotes.tickByTicks) if quotes else 0

    sample = None
    if trades and trades.tickByTicks:
        t = trades.tickByTicks[-1]
        sample = f"{t.size} @ {t.price} on {getattr(t, 'exchange', '?')}"

    for c in (contract,):
        try:
            ib.cancelTickByTickData(c, "AllLast")
            ib.cancelTickByTickData(c, "BidAsk")
        except Exception:
            pass

    return n_trades, n_quotes, sample


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*", default=["NVDA"])
    ap.add_argument("--port", type=int, default=None,
                    help="Skip port discovery and use this one")
    ap.add_argument("--client-id", type=int, default=77)
    args = ap.parse_args()
    symbols = args.symbols or ["NVDA"]

    print("\n=== 1. Connecting ===")
    ib, port = connect(args.port, args.client_id)
    if not ib:
        print("\nCould not reach IB Gateway or TWS on any known port.")
        print("Start IB Gateway, then in Configure > API > Settings:")
        print("  - tick 'Enable ActiveX and Socket Clients'")
        print("  - add 127.0.0.1 to Trusted IPs")
        print("  - note the Socket port and pass it with --port")
        return 1

    errors = ErrorLog(ib)
    ib.reqMarketDataType(1)  # 1 = live. Ask for real data so gaps are real.

    accounts = ib.managedAccounts()
    print(f"  accounts: {', '.join(accounts) if accounts else '(none reported)'}")

    print("\n=== 2. Market depth (the gate) ===")
    depth_ok = False
    for symbol in symbols:
        # ISLAND is Nasdaq's own book (TotalView). ARCA is NYSE Arca
        # (ArcaBook). SMART aggregates, but only across books you already have,
        # so it is tried last and proves nothing on its own.
        for exchange, smart, needs in [
            ("ISLAND", False, "NASDAQ TotalView-OpenView"),
            ("ARCA", False, "NYSE ArcaBook"),
            ("SMART", True, "any depth subscription"),
        ]:
            result = probe_depth(ib, errors, symbol, exchange, smart)
            rows, errs = result[0], result[1]
            tag = f"  {symbol:<6} {exchange:<7}"
            if rows:
                ticker = result[2]
                best_bid = ticker.domBids[0] if ticker.domBids else None
                best_ask = ticker.domAsks[0] if ticker.domAsks else None
                print(f"{tag} OK -- {len(ticker.domBids)} bid / {len(ticker.domAsks)} ask levels")
                if best_bid and best_ask:
                    print(f"{'':<16}top: {best_bid.size} @ {best_bid.price}"
                          f"  |  {best_ask.size} @ {best_ask.price}")
                depth_ok = True
            else:
                reason = "no rows and no error (market closed, or not entitled)"
                for code, msg in errs:
                    label = ENTITLEMENT_CODES.get(code)
                    reason = f"[{code}] {msg}" + (f"  <- {label}" if label else "")
                    break
                print(f"{tag} -- {reason}")
                if any(c in ENTITLEMENT_CODES for c, _ in errs):
                    print(f"{'':<16}needs: {needs}")

    print("\n=== 3. Tick-by-tick (the trade tape) ===")
    for symbol in symbols:
        out = probe_ticks(ib, errors, symbol)
        if out is None:
            print(f"  {symbol:<6} could not qualify contract")
            continue
        n_trades, n_quotes, sample = out
        print(f"  {symbol:<6} {n_trades} trades, {n_quotes} quote updates in 5s")
        if sample:
            print(f"{'':<9}last: {sample}")
        if n_trades and not n_quotes:
            print(f"{'':<9}note: trades without quotes means the aggressor side")
            print(f"{'':<9}      cannot be inferred -- BidAsk ticks are required")

    if errors.general:
        print("\n=== Other errors ===")
        for code, msg in errors.general:
            print(f"  [{code}] {msg}")

    print("\n=== Verdict ===")
    if depth_ok:
        print("  Depth works. The absorption recorder can be built on this.")
    else:
        print("  No depth on any book.")
        print("  The Value Bundle and the US Equity and Options Add-On Streaming")
        print("  Bundle are Level 1 only -- top of book -- and neither enables")
        print("  reqMktDepth. Add one of:")
        print("    - NASDAQ TotalView-OpenView  (~$15/mo) for Nasdaq-listed names")
        print("    - NYSE OpenBook / ArcaBook             for NYSE-listed names")
        print("  If the market is closed, re-run during regular hours before")
        print("  concluding anything: a quiet book and a missing entitlement")
        print("  look the same outside 9:30-16:00 ET.")

    ib.disconnect()
    return 0 if depth_ok else 2


if __name__ == "__main__":
    sys.exit(main())
