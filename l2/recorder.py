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

Alongside that it pushes each watched symbol's ladder every couple of seconds
for the panel's live view. The server holds only the latest one, in memory.

Which symbols it watches is set from the panel. The command line gives the
morning's list; the server's reply to every book push says what the list is
now, and the recorder starts and stops subscriptions to match.

Usage:
    .venv/Scripts/python recorder.py MRVL NVDA
    .venv/Scripts/python recorder.py MRVL --url http://localhost:3001 --port 4001

Auth, in order of preference:
    ORDERFLOW_TOKEN   shared secret, matched against the server's own
    ORDERFLOW_COOKIE  a browser session cookie, for local testing
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
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

# IBKR's depth allowance at this account's market-data lines. A fourth request
# is refused by the gateway, so the cap is held here and on the server rather
# than discovered as an error halfway through a session.
MAX_SYMBOLS = 3

# Notices IBKR sends on every connection, and the echo a cancelled depth
# request leaves behind. None of them mean anything is wrong with a symbol.
NOISE_CODES = {2100, 2104, 2106, 2107, 2108, 2119, 2150, 2158, 310}


def _num(x):
    # IBKR reports an absent quote as NaN, and NaN is not valid JSON -- one in
    # a push gets the whole body refused.
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) or math.isinf(x) else x


class Uploader:
    """
    Batches pushes. A level updates on almost every book tick, so sending each
    one would be thousands of requests an hour to say very little; the flush
    interval trades a little staleness for a sane request rate.
    """

    def __init__(self, url: str, token: str | None, cookie: str | None):
        self.base = url.rstrip("/")
        self.token = token
        self.cookie = cookie
        self.pending: dict[str, list] = {}
        self.sent = 0
        self.failed = 0
        self.last_error: str | None = None

    def _send(self, method: str, path: str, payload: dict):
        """One JSON request. The decoded reply, or None if it failed."""
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(payload).encode())
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("x-orderflow-token", self.token)
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            self.last_error = f"HTTP {e.code} {e.reason}"
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
        return None

    def queue(self, ticker: str, event_row: dict) -> None:
        self.pending.setdefault(ticker, []).append(event_row)

    def flush(self, ticker: str, session: str, levels: list[dict]) -> bool:
        events = self.pending.pop(ticker, [])
        if not events and not levels:
            return True
        body = {"ticker": ticker, "session": session,
                "events": events, "levels": levels}
        if self._send("POST", "/api/orderflow/events", body) is not None:
            self.sent += len(events)
            return True
        # Put them back so a blip does not lose the day's events.
        self.pending.setdefault(ticker, [])[:0] = events
        self.failed += len(events)
        return False

    def push_books(self, books: list[dict], status: dict):
        return self._send("POST", "/api/orderflow/book",
                          {"books": books, "status": status})

    def put_watch(self, symbols: list[str]):
        return self._send("PUT", "/api/orderflow/watch", {"symbols": symbols})


class Recorder:
    def __init__(self, ib: IB, symbol: str, uploader: Uploader, rows: int,
                 engine: AbsorptionEngine | None = None):
        self.ib = ib
        self.symbol = symbol
        self.up = uploader
        self.bid = None
        self.ask = None
        self.last = None
        self.trades = 0

        # A symbol dropped from the watch list and added back the same day keeps
        # its engine. The server replaces a level's row on every push, so a
        # fresh engine would overwrite the morning's totals with a few minutes'.
        self.engine = engine or AbsorptionEngine(
            symbol, thresholds=Thresholds(), on_event=self._on_event)

        found = [c for c in ib.qualifyContracts(Stock(symbol, "SMART", "USD")) if c]
        if not found:
            raise ValueError(f"IBKR does not recognise {symbol}")
        self.contract = found[0]
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
                self.last = t.price
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

    def book(self) -> dict:
        """
        What is resting right now, one row per price.

        Smart depth reports each venue separately, so one price can arrive as
        several rows -- 100 on IEX, 200 on MEMX. A ladder reads by price, so
        they are summed, and the venues are kept for anyone who wants to know
        who is actually there.
        """
        def by_price(rows, descending):
            m: dict[float, dict] = {}
            for r in rows:
                price, size = _num(r.price), _num(r.size)
                if price is None or not size or size <= 0:
                    continue
                e = m.setdefault(price, {"price": price, "size": 0.0, "venues": []})
                e["size"] += size
                if r.marketMaker and r.marketMaker not in e["venues"]:
                    e["venues"].append(r.marketMaker)
            return sorted(m.values(), key=lambda e: e["price"], reverse=descending)

        return {
            "ticker": self.symbol, "ts": time.time(),
            "bids": by_price(self.depth.domBids, True),
            "asks": by_price(self.depth.domAsks, False),
            "bid": _num(self.bid), "ask": _num(self.ask), "last": _num(self.last),
        }

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
    # 10 rows covers about 3% of price on a name like MRVL -- too narrow to
    # contain the levels anyone actually watches. 30 reaches far enough to hold
    # a wall several percent away, which is where support and resistance get
    # argued about.
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--flush", type=float, default=15.0,
                    help="seconds between event pushes")
    ap.add_argument("--book", type=float, default=2.0,
                    help="seconds between live book pushes")
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
    session = datetime.now().strftime("%Y-%m-%d")
    recorders: dict[str, Recorder] = {}
    dormant: dict[str, AbsorptionEngine] = {}
    errors: dict[str, str] = {}
    # Symbols that failed to start. Retried only once they leave the watch list
    # and come back, or every book push would ask IBKR the same doomed question.
    refused: set[str] = set()

    def on_error(reqId, code, msg, contract):
        sym = getattr(contract, "symbol", "") if contract else ""
        if sym and code not in NOISE_CODES:
            errors[sym] = f"[{code}] {msg[:160]}"
    ib.errorEvent += on_error

    def start(sym: str):
        if sym in recorders or len(recorders) >= MAX_SYMBOLS:
            return
        errors.pop(sym, None)
        try:
            recorders[sym] = Recorder(ib, sym, up, args.rows, engine=dormant.pop(sym, None))
            print(f"  + watching {sym}")
        except Exception as e:
            errors[sym] = f"{type(e).__name__}: {e}"
            refused.add(sym)
            print(f"  ! could not watch {sym}: {errors[sym]}")

    def stop(sym: str):
        r = recorders.pop(sym)
        up.flush(sym, session, r.level_rows())
        r.stop()
        dormant[sym] = r.engine
        errors.pop(sym, None)
        print(f"  - stopped {sym}")

    wanted = list(dict.fromkeys(s.upper() for s in args.symbols))[:MAX_SYMBOLS]
    for s in wanted:
        start(s)
    # The command line sets the morning's list; the panel edits it from here.
    up.put_watch(wanted)

    if "805d" in args.url:
        print("WARNING: pushing to the -805d spare. Nothing reads that instance; "
              "the app is served by robinhood-pnl-tracker-production.")
    print(f"Recording {', '.join(recorders)} -> {args.url}")
    print(f"session {session}, book every {args.book:.0f}s, events every "
          f"{args.flush:.0f}s. Ctrl+C to stop.")
    last_flush = time.monotonic()
    try:
        while True:
            ib.sleep(args.book)
            reply = up.push_books([r.book() for r in recorders.values()],
                                  {"active": list(recorders), "errors": errors})
            if reply is not None:
                listed = reply.get("symbols")
                if listed is None:
                    # The server redeployed and forgot the list. This process
                    # still knows it, so it puts it back.
                    up.put_watch(list(recorders))
                else:
                    listed = [str(s).upper() for s in listed][:MAX_SYMBOLS]
                    for s in [s for s in recorders if s not in listed]:
                        stop(s)
                    refused.intersection_update(listed)
                    for s in listed:
                        if s not in refused:
                            start(s)

            if time.monotonic() - last_flush < args.flush:
                continue
            last_flush = time.monotonic()
            for r in recorders.values():
                ok = up.flush(r.symbol, session, r.level_rows())
                state = "ok" if ok else f"FAILED ({up.last_error})"
                note = f"  {errors[r.symbol]}" if r.symbol in errors else ""
                print(f"  {datetime.now():%H:%M:%S} {r.symbol:<6} "
                      f"{r.trades:>7} trades  {len(r.engine.events):>4} events  "
                      f"{len(r.level_rows()):>4} levels  {state}{note}")
    except KeyboardInterrupt:
        pass
    finally:
        print("\nFinal flush...")
        for r in recorders.values():
            up.flush(r.symbol, session, r.level_rows())
            r.stop()
        ib.disconnect()
        print(f"Sent {up.sent} events" + (f", {up.failed} failed" if up.failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
