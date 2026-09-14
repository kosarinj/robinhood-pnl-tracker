"""
Absorption engine — separating orders that were eaten from orders that were pulled.

A large offer at $102 disappears. Two completely different things could have
happened, and the order book looks identical either way:

  - Buyers ate it. 200k shares actually printed at $102. Real demand, and the
    level is likely to break.
  - The seller pulled it. Nothing printed, the order was cancelled. Noise,
    and frequently deliberate noise.

Depth alone cannot tell those apart, which is why staring at Level 2 convinces
people they see things that are not there. Put the trade tape next to it and it
becomes arithmetic. That arithmetic is all this module is.

The signal worth having is the third case: a level that keeps displaying 20k,
has 300k print through it, and *keeps coming back*. That is one large seller
working an order behind an iceberg, not a wall. Buyers spend themselves against
it, the aggressive buying dries up, and price rolls over. That is the top of the
day, and `refreshed` is what exposes it.

Feed-agnostic on purpose: it takes book updates and trades as plain numbers, so
the same engine runs against IBKR, a replay file, or a synthetic test.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Iterable


class Side(str, Enum):
    BID = "bid"
    ASK = "ask"


class Aggressor(str, Enum):
    """Who crossed the spread. BUY lifted the offer, SELL hit the bid."""
    BUY = "buy"
    SELL = "sell"
    UNKNOWN = "unknown"


class EventKind(str, Enum):
    WALL = "wall"              # a level got big enough to matter
    ABSORBED = "absorbed"      # size kept refilling while volume printed through
    CONSUMED = "consumed"      # the level emptied, and trades did it
    PULLED = "pulled"          # the level emptied, and cancels did it


@dataclass
class Thresholds:
    """
    What counts as large. These are the numbers that have to be calibrated per
    ticker — a 20k wall is enormous in a $400 stock and noise in SPY — so they
    are arguments rather than constants. `from_profile` derives a starting set
    from the average trade size, which is the cheapest honest calibration.
    """
    # Measured, not guessed. Sampling NVDA on SMART depth gave displayed sizes
    # of median 100, p90 508, max 1132 -- the book arrives in small slices
    # rather than the blocks a single-venue feed shows. A 10k wall threshold
    # could never trigger, so the first live run produced zero events from a
    # perfectly working pipeline. calibrate.py re-measures for a given name.
    #
    # Note the two scale differently: displayed size does not grow with the
    # session, but volume through a level does, so the wall threshold is set
    # from the book and the absorbed threshold from a day's worth of trading.
    min_wall_size: float = 1_000         # shares displayed at one level
    min_absorbed_volume: float = 25_000  # shares printed through a level
    min_absorption_ratio: float = 3.0    # consumed / max displayed at once
    min_flush_size: float = 500          # ignore the emptying of tiny levels
    dominance: float = 0.7               # share of the flush one cause must own
    # Size a level must reach once before its adds and cancels are counted.
    # Without this the inside of the book buries the signal: the touch flickers
    # between 100 and 200 shares hundreds of times a minute, and each flicker
    # books as a cancel and a refill. On one NVDA run that produced 1.5M
    # "pulled" at a level that never showed more than 100 shares.
    min_track_size: float = 200

    @classmethod
    def from_profile(cls, avg_trade_size: float, multiple: float = 40.0) -> "Thresholds":
        """
        A wall is worth noticing at roughly `multiple` average trades. Crude, but
        it scales with the name instead of pretending SPY and a $400 stock have
        the same book.
        """
        wall = max(1_000.0, avg_trade_size * multiple)
        return cls(
            min_wall_size=wall,
            min_absorbed_volume=wall * 2.5,
            min_flush_size=wall * 0.5,
            min_track_size=wall * 0.2,
        )


@dataclass
class Event:
    kind: EventKind
    symbol: str
    side: Side
    price: float
    ts: float
    displayed: float          # size shown at the moment of the event
    max_displayed: float      # largest it ever showed at once
    consumed: float           # shares removed by actual trades
    pulled: float             # shares removed by cancellation
    refreshed: float          # shares added back after being traded down
    volume: float             # total printed at this price
    buy_volume: float
    sell_volume: float
    ratio: float              # consumed / max_displayed

    def as_row(self) -> dict:
        d = self.__dict__.copy()
        d["kind"] = self.kind.value
        d["side"] = self.side.value
        return d


@dataclass
class Level:
    """Running state for one price on one side of the book."""
    side: Side
    price: float
    displayed: float = 0.0
    max_displayed: float = 0.0
    consumed: float = 0.0
    pulled: float = 0.0
    refreshed: float = 0.0
    volume: float = 0.0
    buy_volume: float = 0.0
    sell_volume: float = 0.0
    # Volume printed here that the next book update has not yet accounted for.
    # This is the whole trick: a size decrease is only "consumed" up to the
    # volume that actually traded in the same window.
    unaccounted: float = 0.0
    # First sighting is an observation, not a change: without this the initial
    # size of every level is booked as though somebody had just added it.
    seen: bool = False
    announced_wall: bool = False
    announced_absorbed_at: float = 0.0

    @property
    def ratio(self) -> float:
        return self.consumed / self.max_displayed if self.max_displayed else 0.0


class AbsorptionEngine:
    """
    Feed book updates and trades in; get events out.

    Ordering matters. `on_trade` must be called for prints that happened before
    the `on_book` update that reflects them — which is the natural arrival order
    on every feed, since the book is a snapshot of the state *after* the trade.
    """

    def __init__(
        self,
        symbol: str,
        thresholds: Thresholds | None = None,
        on_event: Callable[[Event], None] | None = None,
        tick: float = 0.01,
    ):
        self.symbol = symbol
        self.t = thresholds or Thresholds()
        self.levels: dict[tuple[Side, float], Level] = {}
        self.events: list[Event] = []
        self._on_event = on_event
        self.tick = tick

    # ── internals ────────────────────────────────────────────────────────────

    def _key(self, side: Side, price: float) -> tuple[Side, float]:
        # Float prices as dict keys are a bug waiting to happen; snap to the tick
        # so 102.00 and 102.0000001 are the same level.
        return (side, round(price / self.tick) * self.tick)

    def _level(self, side: Side, price: float) -> Level:
        k = self._key(side, price)
        lv = self.levels.get(k)
        if lv is None:
            lv = Level(side=side, price=k[1])
            self.levels[k] = lv
        return lv

    def _emit(self, kind: EventKind, lv: Level, ts: float) -> Event:
        ev = Event(
            kind=kind, symbol=self.symbol, side=lv.side, price=lv.price, ts=ts,
            displayed=lv.displayed, max_displayed=lv.max_displayed,
            consumed=lv.consumed, pulled=lv.pulled, refreshed=lv.refreshed,
            volume=lv.volume, buy_volume=lv.buy_volume, sell_volume=lv.sell_volume,
            ratio=lv.ratio,
        )
        self.events.append(ev)
        if self._on_event:
            self._on_event(ev)
        return ev

    # ── inputs ───────────────────────────────────────────────────────────────

    def on_trade(self, price: float, size: float, ts: float,
                 aggressor: Aggressor = Aggressor.UNKNOWN) -> None:
        """A print at `price`. Attributed to the level it traded at."""
        if size <= 0:
            return
        for side in (Side.BID, Side.ASK):
            k = self._key(side, price)
            lv = self.levels.get(k)
            if lv is None or lv.displayed <= 0:
                continue
            lv.volume += size
            lv.unaccounted += size
            if aggressor is Aggressor.BUY:
                lv.buy_volume += size
            elif aggressor is Aggressor.SELL:
                lv.sell_volume += size

    def on_book(self, side: Side, price: float, size: float, ts: float) -> None:
        """
        The displayed size at one level, after any trades already reported.

        The split is the point of the whole module:

            expected = old - traded_since_last_update

        Land below `expected` and the difference was cancelled. Land above it and
        the difference was added back — that is a refresh, and a level that keeps
        refreshing while volume prints through it is somebody working size.
        """
        lv = self._level(side, price)
        if not lv.seen:
            lv.seen = True
            lv.displayed = size
            lv.max_displayed = max(lv.max_displayed, size)
            lv.unaccounted = 0.0
            self._check(lv, ts)
            return

        old = lv.displayed
        traded = lv.unaccounted
        lv.unaccounted = 0.0

        expected = old - traded
        # A level only counts once it has been big enough to mean something.
        # Consumption is always real -- those shares printed -- but attributing
        # adds and cancels on a level that has never held size is measuring the
        # spread flickering, not anyone's intent.
        material = max(lv.max_displayed, size) >= self.t.min_track_size
        if size > expected:
            lv.consumed += min(traded, old)
            if material:
                lv.refreshed += size - max(expected, 0.0)
        else:
            lv.consumed += traded
            if material:
                lv.pulled += expected - size

        lv.displayed = size
        lv.max_displayed = max(lv.max_displayed, size)

        self._check(lv, ts)

    # ── event rules ──────────────────────────────────────────────────────────

    def _check(self, lv: Level, ts: float) -> None:
        # A level worth watching at all.
        if not lv.announced_wall and lv.displayed >= self.t.min_wall_size:
            lv.announced_wall = True
            self._emit(EventKind.WALL, lv, ts)

        # Absorption: real volume has gone through, and the level showed far
        # less than it ate. Re-announced only after the consumed figure has
        # grown by another full threshold, so one long episode is a handful of
        # events rather than one per book update.
        if (lv.consumed >= self.t.min_absorbed_volume
                and lv.ratio >= self.t.min_absorption_ratio
                and lv.consumed - lv.announced_absorbed_at >= self.t.min_absorbed_volume):
            lv.announced_absorbed_at = lv.consumed
            self._emit(EventKind.ABSORBED, lv, ts)

        # The level emptied. Which cause dominated decides what it means, and
        # `dominance` keeps a mixed flush from being reported as either.
        if lv.displayed <= 0 and lv.max_displayed >= self.t.min_flush_size:
            total = lv.consumed + lv.pulled
            if total > 0:
                if lv.consumed / total >= self.t.dominance:
                    self._emit(EventKind.CONSUMED, lv, ts)
                elif lv.pulled / total >= self.t.dominance:
                    self._emit(EventKind.PULLED, lv, ts)
            # Reset so the same price can form a fresh wall later in the day.
            lv.announced_wall = False

    # ── output ───────────────────────────────────────────────────────────────

    def levels_by_absorption(self, min_consumed: float = 0.0) -> list[Level]:
        """Today's levels, most absorbed first. This is the support/resistance read."""
        return sorted(
            (lv for lv in self.levels.values() if lv.consumed >= min_consumed),
            key=lambda lv: lv.consumed, reverse=True,
        )

    def summary(self) -> list[dict]:
        return [
            {
                "side": lv.side.value, "price": round(lv.price, 4),
                "max_displayed": lv.max_displayed, "consumed": lv.consumed,
                "pulled": lv.pulled, "refreshed": lv.refreshed,
                "volume": lv.volume, "buy_volume": lv.buy_volume,
                "sell_volume": lv.sell_volume, "ratio": round(lv.ratio, 2),
            }
            for lv in self.levels_by_absorption()
        ]


def replay(engine: AbsorptionEngine, steps: Iterable[tuple]) -> list[Event]:
    """
    Run a scripted sequence. Each step is ("book", side, price, size, ts) or
    ("trade", price, size, ts[, aggressor]). Used by the tests, and by any
    replay of a recorded session.
    """
    for step in steps:
        if step[0] == "book":
            _, side, price, size, ts = step
            engine.on_book(side, price, size, ts)
        elif step[0] == "trade":
            price, size, ts = step[1:4]
            agg = step[4] if len(step) > 4 else Aggressor.UNKNOWN
            engine.on_trade(price, size, ts, agg)
        else:
            raise ValueError(f"unknown step {step[0]}")
    return engine.events
