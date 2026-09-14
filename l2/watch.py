"""
Live order book with absorption, in the terminal.

Shows the depth ladder on the left and what the engine has worked out on the
right: how much has actually printed through each level, how much was eaten
versus cancelled, and whether the level keeps refilling.

The refill column is the one to watch. A level showing 20k that has eaten 300k
and keeps coming back is a large seller working an order behind an iceberg --
and that is where a rally usually runs out.

Usage:
    .venv/Scripts/python watch.py NVDA
    .venv/Scripts/python watch.py NVDA --port 4001 --rows 12
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

from ib_async import IB, Stock

from engine import AbsorptionEngine, Aggressor, EventKind, Side, Thresholds

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"

KIND_STYLE = {
    EventKind.WALL: (CYAN, "WALL"),
    EventKind.ABSORBED: (YELLOW, "ABSORBED"),
    EventKind.CONSUMED: (GREEN, "EATEN"),
    EventKind.PULLED: (RED, "PULLED"),
}


def human(n: float) -> str:
    if n is None:
        return "-"
    n = float(n)
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if abs(n) >= 1_000:
        return f"{n / 1_000:.1f}k"
    return f"{n:.0f}"


class Watcher:
    def __init__(self, ib: IB, symbol: str, rows: int):
        self.ib = ib
        self.symbol = symbol
        self.rows = rows
        self.log: list[str] = []
        self.trades = 0
        self.quotes = 0
        # Best bid/ask held from the quote stream. IBKR does not label a print
        # with its aggressor, so it has to be inferred: a trade at or above the
        # offer was a buyer lifting, at or below the bid a seller hitting.
        self.bid = None
        self.ask = None

        self.engine = AbsorptionEngine(
            symbol, thresholds=Thresholds(), on_event=self._on_event)

        contract = Stock(symbol, "SMART", "USD")
        self.contract = ib.qualifyContracts(contract)[0]

        # SMART aggregates the books this account is entitled to. isSmartDepth
        # must match on the cancel or the subscription is orphaned.
        self.depth = ib.reqMktDepth(self.contract, numRows=rows, isSmartDepth=True)
        self.depth.updateEvent += self._on_depth

        self.tape = ib.reqTickByTickData(self.contract, "AllLast", 0, False)
        self.quote = ib.reqTickByTickData(self.contract, "BidAsk", 0, False)
        for t in {id(self.tape): self.tape, id(self.quote): self.quote}.values():
            t.updateEvent += self._on_tick

    # ── feed handlers ────────────────────────────────────────────────────────

    def _classify(self, price: float) -> Aggressor:
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
                self.quotes += 1
            elif hasattr(t, "size"):
                self.trades += 1
                self.engine.on_trade(t.price, float(t.size), now,
                                     self._classify(t.price))

    def _on_depth(self, ticker):
        now = datetime.now().timestamp()
        # Trades must already be applied when the book update lands -- the book
        # is the state *after* the print -- which the event ordering gives us.
        for side, rows in ((Side.BID, ticker.domBids), (Side.ASK, ticker.domAsks)):
            for row in rows:
                self.engine.on_book(side, row.price, float(row.size), now)

    def _on_event(self, ev):
        colour, label = KIND_STYLE.get(ev.kind, ("", ev.kind.value.upper()))
        when = datetime.fromtimestamp(ev.ts).strftime("%H:%M:%S")
        self.log.append(
            f"{DIM}{when}{RESET} {colour}{label:<9}{RESET} "
            f"{ev.side.value:<4} {ev.price:>9.2f}  "
            f"ate {human(ev.consumed):>7}  pulled {human(ev.pulled):>7}  "
            f"refill {human(ev.refreshed):>7}  {ev.ratio:>5.1f}x"
        )
        self.log = self.log[-14:]

    # ── rendering ────────────────────────────────────────────────────────────

    def render(self):
        # Only repaint in place on a real terminal. Piped to a file or a pager
        # the clear swallows everything that came before it, which makes the
        # thing impossible to capture or debug.
        if sys.stdout.isatty():
            os.system("cls" if os.name == "nt" else "clear")
        else:
            print(chr(10) + "=" * 72)
        e = self.engine
        spread = f"{self.bid:.2f} / {self.ask:.2f}" if self.bid and self.ask else "-"
        print(f"{BOLD}{self.symbol}{RESET}   {spread}   "
              f"{DIM}{self.trades} trades - {self.quotes} quotes - "
              f"{len(e.events)} events{RESET}\n")

        print(f"{BOLD}{'BOOK':<28}{'ate':>9}{'pulled':>9}{'refill':>9}{'ratio':>8}{RESET}")

        asks = sorted((lv for lv in e.levels.values()
                       if lv.side is Side.ASK and lv.displayed > 0),
                      key=lambda l: l.price, reverse=True)[-self.rows:]
        bids = sorted((lv for lv in e.levels.values()
                       if lv.side is Side.BID and lv.displayed > 0),
                      key=lambda l: l.price, reverse=True)[:self.rows]

        for lv in asks:
            self._row(lv, RED)
        print(f"  {DIM}{'-' * 60}{RESET}")
        for lv in bids:
            self._row(lv, GREEN)

        if self.log:
            print(f"\n{BOLD}EVENTS{RESET}")
            for line in self.log:
                print("  " + line)

    def _row(self, lv, colour):
        # Highlight the levels doing real work: lots eaten relative to what was
        # ever shown at once.
        hot = YELLOW if lv.ratio >= 3 and lv.consumed >= 25_000 else ""
        bar = "#" * min(20, int(lv.displayed / 2_000))
        print(f"  {colour}{lv.price:>9.2f}{RESET} {human(lv.displayed):>7} "
              f"{DIM}{bar:<20}{RESET}"
              f"{hot}{human(lv.consumed):>9}{RESET}"
              f"{human(lv.pulled):>9}{human(lv.refreshed):>9}"
              f"{hot}{lv.ratio:>7.1f}x{RESET}")

    def stop(self):
        try:
            self.ib.cancelMktDepth(self.contract, isSmartDepth=True)
            self.ib.cancelTickByTickData(self.contract, "AllLast")
            self.ib.cancelTickByTickData(self.contract, "BidAsk")
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("--port", type=int, default=4001)
    ap.add_argument("--client-id", type=int, default=78)
    ap.add_argument("--rows", type=int, default=30)
    args = ap.parse_args()

    ib = IB()
    # readonly: nothing here wants order data, and asking for it under a
    # Read-Only Gateway logs a timeout that looks like a permissions problem.
    ib.connect("127.0.0.1", args.port, clientId=args.client_id,
               timeout=8, readonly=True)

    w = Watcher(ib, args.symbol.upper(), args.rows)
    print(f"Watching {w.symbol}. Ctrl+C to stop.")
    try:
        while True:
            ib.sleep(1.0)
            w.render()
    except KeyboardInterrupt:
        pass
    finally:
        w.stop()
        ib.disconnect()
        print("\nStopped.")
        for row in w.engine.summary()[:10]:
            print(f"  {row['side']:<4} {row['price']:>9.2f}  "
                  f"ate {human(row['consumed']):>8}  "
                  f"refill {human(row['refreshed']):>8}  {row['ratio']}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
