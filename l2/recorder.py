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

    def push_scan(self, results: list[dict]):
        return self._send("POST", "/api/orderflow/scan/result", {"results": results})


class Recorder:
    def __init__(self, ib: IB, symbol: str, uploader: Uploader | None, rows: int,
                 engine: AbsorptionEngine | None = None, quiet: bool = False):
        self.ib = ib
        self.symbol = symbol
        self.up = uploader
        # A screener pass watches a name for half a minute and throws the book
        # away. Its events are not the day's record of that ticker and must not
        # join it, so quiet subscriptions feed the engine and push nothing.
        self.quiet = quiet
        self.bid = None
        self.ask = None
        self.last = None
        self.trades = 0
        # The level rows the server already holds, as last sent. Resending all
        # of them every flush grew past 900 rows a push on a busy name and got
        # refused as too large; only what moved needs to travel.
        self._sent: dict[tuple, dict] = {}

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
        if self.quiet:
            return
        row = ev.as_row()
        # Where the stock was trading when this fired. The event knows its own
        # price level; without the underlying beside it, nothing later can ask
        # whether price then moved toward that level or away from it.
        row["under_px"] = _num(self.last)
        self.up.queue(self.symbol, row)

    def level_rows(self, min_consumed: float = 1.0) -> list[dict]:
        # Only levels that did something. Sending every price the book has
        # touched would be mostly zeroes.
        return [r for r in self.engine.summary() if r["consumed"] >= min_consumed]

    def changed_levels(self, limit: int = 400) -> list[dict]:
        # Capped so a reconnect, which starts with nothing marked sent, spreads
        # a whole day's levels over a few pushes instead of one huge one.
        rows = [r for r in self.level_rows()
                if self._sent.get((r["side"], r["price"])) != r]
        return rows[:limit]

    def mark_sent(self, rows: list[dict]) -> None:
        for r in rows:
            self._sent[(r["side"], r["price"])] = r

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


class Scan:
    """
    One short look at a ticker for the screener.

    IBKR allows three books at once. The watch list gets first claim on them;
    whatever is spare rotates through the scan list, half a minute a name, and
    reports four things that mean different things:

      lean       — resting size near the price, one side against the other.
                   Cheap, and the first thing to be pulled.
      wall       — the largest order on either side with nothing comparable on
                   the other. A price, not a mood.
      absorption — size that actually traded through a level while watching.
                   The strongest of the four, and the one half a minute may be
                   too short to catch.
      tape       — who was hitting: buy-initiated against sell-initiated volume.

    They are reported separately, and the score keeps its parts visible, because
    a single number nobody can take apart is a number nobody should trade on.
    """

    def __init__(self, ib: IB, symbol: str, rows: int):
        self.symbol = symbol
        self.started = time.monotonic()
        self.rec = Recorder(ib, symbol, None, rows, quiet=True)

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def stop(self):
        self.rec.stop()

    def result(self, cfg: dict) -> dict:
        r = self.rec
        book = r.book()
        bids, asks = book["bids"], book["asks"]
        px = book["last"]
        if px is None and bids and asks:
            px = (bids[0]["price"] + asks[0]["price"]) / 2

        near_bid = near_ask = 0.0
        if px:
            window = px * cfg["nearPct"] / 100.0
            near_bid = sum(b["size"] for b in bids if px - b["price"] <= window)
            near_ask = sum(a["size"] for a in asks if a["price"] - px <= window)
        near_total = near_bid + near_ask
        lean = (near_bid / near_total) if near_total else None

        biggest = lambda rows: max(rows, key=lambda x: x["size"], default=None)
        top_bid, top_ask = biggest(bids), biggest(asks)
        wall = opp = None
        if top_bid or top_ask:
            wall, opp = ((top_bid, top_ask) if (top_bid["size"] if top_bid else 0)
                         >= (top_ask["size"] if top_ask else 0) else (top_ask, top_bid))
        wall_ratio = (wall["size"] / opp["size"]) if (wall and opp and opp["size"]) else None
        unopposed = bool(wall and (not opp or wall["size"] >= opp["size"] * 1.5))

        # Absorption: what a level ate against the most it ever showed, over the
        # window only -- this engine was born when the scan started.
        levels = r.engine.summary()
        # Half a minute is short: any level that actually traded counts.
        eaten = [l for l in levels if l["consumed"] > 0]
        best = max(eaten, key=lambda l: l["ratio"], default=None)

        buy_vol = sum(l["buy_volume"] for l in levels)
        sell_vol = sum(l["sell_volume"] for l in levels)
        flow = buy_vol + sell_vol
        buy_pct = (buy_vol / flow) if flow else None

        # Parts kept, not just the total.
        p_lean = abs(lean - 0.5) * 2 * 40 if lean is not None else 0.0
        p_wall = 30 * min(1.0, (wall_ratio or 3) / 3) if unopposed else 0.0
        p_abs = 20 * min(1.0, (best["ratio"] if best else 0) / 5)
        p_tape = abs(buy_pct - 0.5) * 2 * 10 if buy_pct is not None else 0.0

        return {
            "ticker": self.symbol, "ts": time.time(), "seconds": round(self.elapsed(), 1),
            "price": _num(px), "bid": book["bid"], "ask": book["ask"],
            "restingBid": near_bid, "restingAsk": near_ask, "lean": lean,
            "wallSide": ("bid" if wall and top_bid is wall else "ask") if wall else None,
            "wallPrice": wall["price"] if wall else None,
            "wallSize": wall["size"] if wall else None,
            "wallDistPct": (abs(wall["price"] - px) / px * 100) if (wall and px) else None,
            "oppSize": opp["size"] if opp else 0,
            "wallRatio": wall_ratio, "unopposed": unopposed,
            "absPrice": best["price"] if best else None,
            "absRatio": best["ratio"] if best else None,
            "absConsumed": best["consumed"] if best else None,
            "trades": r.trades, "buyVol": buy_vol, "sellVol": sell_vol, "buyPct": buy_pct,
            "score": round(p_lean + p_wall + p_abs + p_tape, 1),
            "parts": {"lean": round(p_lean, 1), "wall": round(p_wall, 1),
                      "absorption": round(p_abs, 1), "tape": round(p_tape, 1)},
        }


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
    # Screener state: what is being sampled now, and where the rotation is up to.
    scans: dict[str, Scan] = {}
    scan_at = 0
    SCAN_DEFAULTS = {"seconds": 30, "nearPct": 1.0, "bigMult": 3}

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

    def push_levels(r: Recorder) -> bool:
        rows = r.changed_levels()
        ok = up.flush(r.symbol, session, rows)
        if ok:
            r.mark_sent(rows)
        return ok

    def stop(sym: str):
        r = recorders.pop(sym)
        push_levels(r)
        r.stop()
        dormant[sym] = r.engine
        errors.pop(sym, None)
        print(f"  - stopped {sym}")

    def reconnect():
        # The gateway drops its API clients whenever the same login is used
        # somewhere else -- Client Portal, the phone app -- and comes back once
        # that session ends. Quitting there cost a whole morning's totals, so
        # the engines are kept, and the subscriptions come back with the gateway.
        for sym in list(recorders):
            r = recorders.pop(sym)
            dormant[sym] = r.engine
        refused.clear()
        print(f"  {datetime.now():%H:%M:%S} gateway disconnected -- is IBKR open "
              f"somewhere else? Retrying every 10s")
        while True:
            try:
                ib.disconnect()
            except Exception:
                pass
            time.sleep(10)
            try:
                ib.connect("127.0.0.1", args.port, clientId=args.client_id,
                           timeout=8, readonly=True)
                print(f"  {datetime.now():%H:%M:%S} reconnected to the gateway")
                return
            except Exception as e:
                print(f"  {datetime.now():%H:%M:%S} still no gateway ({type(e).__name__})")

    wanted = list(dict.fromkeys(s.upper() for s in args.symbols))[:MAX_SYMBOLS]
    for s in wanted:
        start(s)
    # The command line sets the morning's list; the panel edits it from here.
    up.put_watch(wanted)
    listed_last = wanted

    if "805d" in args.url:
        print("WARNING: pushing to the -805d spare. Nothing reads that instance; "
              "the app is served by robinhood-pnl-tracker-production.")
    print(f"Recording {', '.join(recorders)} -> {args.url}")
    print(f"session {session}, book every {args.book:.0f}s, events every "
          f"{args.flush:.0f}s. Ctrl+C to stop.")
    last_flush = time.monotonic()
    try:
        while True:
            try:
                if not ib.isConnected():
                    reconnect()
                    for s in listed_last:
                        start(s)
                ib.sleep(args.book)
                reply = up.push_books([r.book() for r in recorders.values()],
                                      {"active": list(recorders), "errors": errors})
                if reply is not None:
                    listed = reply.get("symbols")
                    if listed is None:
                        # The server redeployed and forgot the list. This process
                        # still knows it, so it puts it back.
                        up.put_watch(listed_last)
                    else:
                        listed = [str(s).upper() for s in listed][:MAX_SYMBOLS]
                        listed_last = listed
                        for s in [s for s in recorders if s not in listed]:
                            stop(s)
                        refused.intersection_update(listed)
                        for s in listed:
                            if s not in refused:
                                start(s)

                    # The screener lives on whatever books the watch list is not
                    # using. Watch three names and it simply stops; that is the
                    # right trade, since the panel is what is being looked at.
                    scan_cfg = dict(SCAN_DEFAULTS)
                    scan_cfg.update((reply.get("scan") or {}).get("config") or {})
                    scan_list = [str(s).upper() for s in ((reply.get("scan") or {}).get("list") or [])]

                    finished = []
                    released = False
                    for sym in list(scans):
                        # 309 is the gateway refusing a fourth book. The request
                        # never took, so this scan is holding a slot it does not
                        # have -- drop it and let the rotation come back to it.
                        if errors.get(sym, "").startswith("[309]"):
                            scans.pop(sym).stop()
                            errors.pop(sym, None)
                            released = True
                            continue
                        if sym not in scan_list:
                            scans.pop(sym).stop()
                            released = True
                            continue
                        if scans[sym].elapsed() >= float(scan_cfg["seconds"]):
                            try:
                                finished.append(scans[sym].result(scan_cfg))
                            except Exception as e:
                                print(f"  ! scan {sym} failed: {type(e).__name__}: {e}")
                            scans.pop(sym).stop()
                            released = True
                    if finished:
                        up.push_scan(finished)
                        for f in finished:
                            print(f"  {datetime.now():%H:%M:%S} scanned {f['ticker']:<6} "
                                  f"score {f['score']:>5}  lean "
                                  f"{(f['lean'] * 100 if f['lean'] is not None else 0):.0f}%"
                                  f"{'  unopposed wall' if f['unopposed'] else ''}")

                    # IBKR releases a cancelled depth subscription on its own
                    # clock, so asking for the next book in the same breath as
                    # dropping one got error 309 -- max (3) reached -- and left
                    # a scan holding a slot that was never granted. A tick that
                    # released a slot therefore starts nothing, and no tick
                    # starts more than one.
                    if not released and (MAX_SYMBOLS - len(recorders) - len(scans)) > 0:
                        tries = 0
                        while scan_list and tries < len(scan_list):
                            sym = scan_list[scan_at % len(scan_list)]
                            scan_at += 1
                            tries += 1
                            if sym in scans or sym in recorders:
                                continue
                            try:
                                scans[sym] = Scan(ib, sym, args.rows)
                            except Exception as e:
                                print(f"  ! cannot scan {sym}: {type(e).__name__}: {e}")
                            break

                if time.monotonic() - last_flush < args.flush:
                    continue
                last_flush = time.monotonic()

                # Midnight. The session was stamped once at startup, so a
                # recorder left running overnight -- which is the normal case
                # now that the overnight venue trades -- filed a whole new day
                # under yesterday's date, on top of yesterday's totals.
                today = datetime.now().strftime("%Y-%m-%d")
                if today != session:
                    for r in recorders.values():
                        push_levels(r)
                    print(f"  {datetime.now():%H:%M:%S} new session {today} "
                          f"(was {session}) -- totals start again")
                    session = today
                    for sym, r in recorders.items():
                        r.engine = AbsorptionEngine(
                            sym, thresholds=Thresholds(), on_event=r._on_event)
                        r._sent.clear()
                        r.trades = 0
                    # Yesterday's parked engines belong to yesterday.
                    dormant.clear()

                for r in recorders.values():
                    ok = push_levels(r)
                    state = "ok" if ok else f"FAILED ({up.last_error})"
                    note = f"  {errors[r.symbol]}" if r.symbol in errors else ""
                    print(f"  {datetime.now():%H:%M:%S} {r.symbol:<6} "
                          f"{r.trades:>7} trades  {len(r.engine.events):>4} events  "
                          f"{len(r.level_rows()):>4} levels  {state}{note}")
            except KeyboardInterrupt:
                raise
            except Exception as e:
                # One bad tick or a dropped socket must not end the session.
                # A lost gateway is caught at the top of the next pass.
                print(f"  {datetime.now():%H:%M:%S} recovered from "
                      f"{type(e).__name__}: {e}")
                ib.sleep(2) if ib.isConnected() else time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        print("\nFinal flush...")
        for r in recorders.values():
            push_levels(r)
            r.stop()
        ib.disconnect()
        print(f"Sent {up.sent} events" + (f", {up.failed} failed" if up.failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
