"""
Order flow recorder — watches the book locally, pushes absorption to the app.

Runs on the trading machine beside IB Gateway, because the gateway is a local
program holding a logged-in brokerage session; its credentials have no business
in a cloud environment. What travels is the conclusion, not the feed.

What it sends is an event log, not a tick archive. Storing every book update is
millions of rows a day for one name. The recorder holds the book in memory and
writes only when something worth seeing happens — a level got big, got eaten,
got pulled, or kept refilling — which is a few hundred rows a ticker a day and
happens to be exactly the set of moments worth looking at later.

Usage:
    .venv/Scripts/python recorder.py MRVL NVDA
    .venv/Scripts/python recorder.py MRVL --url http://localhost:3001 --port 4001

Auth, in order of preference:
    ORDERFLOW_TOKEN   shared secret, matched against the server's own
    ORDERFLOW_COOKIE  a browser session cookie, for local testing
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request
import json
from datetime import datetime

from ib_async import IB, Stock

from engine import AbsorptionEngine, Aggressor, Side, Thresholds

# The deployment has two backends and only one of them is real. The app is
# served by robinhood-pnl-tracker-production, which answers both the UI and the
# API; the -805d instance is a spare that responds to every API call, holds its
# own volume, and is read by nothing. A push to it succeeds, returns ok, and
# vanishes -- which is exactly how an hour went into wondering why a working
# recorder produced an empty panel. VITE_SERVER_URL in .env.local still points
# at the spare, so do not take the URL from there.
MAIN_SERVER = "https://robinhood-pnl-tracker-production.up.railway.app"
DEFAULT_URL = os.environ.get("ORDERFLOW_URL", MAIN_SERVER)


class Uploader:
    """
    Batches pushes. A level updates on almost every book tick, so sending each
    one would be thousands of requests an hour to say very little; the flush
    interval trades a little staleness for a sane request rate.
    """

    def __init__(self, url: str, token: str | None, cookie: str | None):
        self.url = url.rstrip("/") + "/api/orderflow/events"
        self.token = token
        self.cookie = cookie
        self.pending: dict[str, list] = {}
        self.sent = 0
        self.failed = 0
        self.last_error: str | None = None

    def queue(self, ticker: str, event_row: dict) -> None:
        self.pending.setdefault(ticker, []).append(event_row)

    def flush(self, ticker: str, session: str, levels: list[dict]) -> bool:
        events = self.pending.pop(ticker, [])
        if not events and not levels:
            return True
        body = json.dumps({
            "ticker": ticker, "session": session,
            "events": events, "levels": levels,
        }).encode()
        req = urllib.request.Request(self.url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("x-orderflow-token", self.token)
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                r.read()
            self.sent += len(events)
            return True
        except urllib.error.HTTPError as e:
            self.last_error = f"HTTP {e.code} {e.reason}"
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
        # Put them back so a blip does not lose the day's events.
        self.pending.setdefault(ticker, [])[:0] = events
        self.failed += len(events)
        return False


class Recorder:
    def __init__(self, ib: IB, symbol: str, uploader: Uploader, rows: int):
        self.ib = ib
        self.symbol = symbol
        self.up = uploader
        self.bid = None
        self.ask = None
        self.trades = 0

        self.engine = AbsorptionEngine(
            symbol, thresholds=Thresholds(), on_event=self._on_event)

        contract = Stock(symbol, "SMART", "USD")
        self.contract = ib.qualifyContracts(contract)[0]
        self.depth = ib.reqMktDepth(self.contract, numRows=rows, isSmartDepth=True)
        self.depth.updateEvent += self._on_depth
        self.tape = ib.reqTickByTickData(self.contract, "AllLast", 0, False)
        self.quote = ib.reqTickByTickData(self.contract, "BidAsk", 0, False)
        for t in {id(self.tape): self.tape, id(self.quote): self.quote}.values():
            t.updateEvent += self._on_tick

    def _classify(self, price: float) -> Aggressor:
        # IBKR does not label a print with its aggressor, so it is inferred from
        # the prevailing quote: at or above the offer was a buyer lifting, at or
        # below the bid a seller hitting. Prints inside the spread stay unknown
        # rather than being guessed at.
        if self.ask is not None and price >= self.ask:
            return Aggressor.BUY
        if self.bid is not None and price <= self.bid:
            return Aggressor.SELL
        return Aggressor.UNKNOWN

    def _on_tick(self, ticker):
        now = datetime.now().timestamp()
        for t in ticker.tickByTicks:
            if hasattr(t, "bidPrice"):
                self.bid, self.ask = t.bidPrice, t.askPrice
            elif hasattr(t, "size"):
                self.trades += 1
                self.engine.on_trade(t.price, float(t.size), now,
                                     self._classify(t.price))

    def _on_depth(self, ticker):
        now = datetime.now().timestamp()
        for side, rows in ((Side.BID, ticker.domBids), (Side.ASK, ticker.domAsks)):
            for row in rows:
                self.engine.on_book(side, row.price, float(row.size), now)

    def _on_event(self, ev):
        self.up.queue(self.symbol, ev.as_row())

    def level_rows(self, min_consumed: float = 1.0) -> list[dict]:
        # Only levels that did something. Sending every price the book has
        # touched would be mostly zeroes.
        return [r for r in self.engine.summary() if r["consumed"] >= min_consumed]

    def stop(self):
        try:
            self.ib.cancelMktDepth(self.contract, isSmartDepth=True)
            self.ib.cancelTickByTickData(self.contract, "AllLast")
            self.ib.cancelTickByTickData(self.contract, "BidAsk")
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="+")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--port", type=int, default=4001)
    ap.add_argument("--client-id", type=int, default=79)
    ap.add_argument("--rows", type=int, default=10)
    ap.add_argument("--flush", type=float, default=15.0,
                    help="seconds between pushes")
    args = ap.parse_args()

    token = os.environ.get("ORDERFLOW_TOKEN")
    cookie = os.environ.get("ORDERFLOW_COOKIE")
    if not token and not cookie:
        print("No ORDERFLOW_TOKEN or ORDERFLOW_COOKIE set -- the server will "
              "reject the push. Set one and retry.")
        return 1

    ib = IB()
    ib.connect("127.0.0.1", args.port, clientId=args.client_id,
               timeout=8, readonly=True)

    up = Uploader(args.url, token, cookie)
    recorders = [Recorder(ib, s.upper(), up, args.rows) for s in args.symbols]
    session = datetime.now().strftime("%Y-%m-%d")

    if "805d" in args.url:
        print("WARNING: pushing to the -805d spare. Nothing reads that instance; "
              "the app is served by robinhood-pnl-tracker-production.")
    print(f"Recording {', '.join(r.symbol for r in recorders)} -> {args.url}")
    print(f"session {session}, flushing every {args.flush:.0f}s. Ctrl+C to stop.")
    try:
        while True:
            ib.sleep(args.flush)
            for r in recorders:
                ok = up.flush(r.symbol, session, r.level_rows())
                state = "ok" if ok else f"FAILED ({up.last_error})"
                print(f"  {datetime.now():%H:%M:%S} {r.symbol:<6} "
                      f"{r.trades:>7} trades  {len(r.engine.events):>4} events  "
                      f"{len(r.level_rows()):>4} levels  {state}")
    except KeyboardInterrupt:
        pass
    finally:
        print("\nFinal flush...")
        for r in recorders:
            up.flush(r.symbol, session, r.level_rows())
            r.stop()
        ib.disconnect()
        print(f"Sent {up.sent} events" + (f", {up.failed} failed" if up.failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
