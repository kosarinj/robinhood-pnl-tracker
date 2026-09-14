"""
Scenarios the absorption engine has to get right.

Written as scripts of book updates and prints because that is the only way to
know the arithmetic works: in live data you never learn what the true answer
was. Here the answer is built into the scenario.

Run:  .venv/Scripts/python test_engine.py
"""

from engine import (
    AbsorptionEngine, Aggressor, EventKind, Side, Thresholds, replay,
)

PASS, FAIL = "ok  ", "FAIL"
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"  [{PASS if ok else FAIL}] {name}")
    if not ok:
        print(f"         got  {got}\n         want {want}")


def engine(**kw):
    t = Thresholds(min_wall_size=10_000, min_absorbed_volume=25_000,
                   min_absorption_ratio=3.0, min_flush_size=5_000)
    return AbsorptionEngine("TEST", thresholds=t, **kw)


print("\n1. A wall that gets eaten")
# 50k offered, 20k prints against it, book drops to 30k. All of it consumed.
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("trade", 102.00, 20_000, 1.5, Aggressor.BUY),
    ("book", Side.ASK, 102.00, 30_000, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("consumed = traded", lv.consumed, 20_000)
check("nothing pulled", lv.pulled, 0)
check("nothing refreshed", lv.refreshed, 0)

print("\n2. A wall that gets pulled")
# Same 50k drops to 30k, but nothing printed. Pure cancellation.
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("book", Side.ASK, 102.00, 30_000, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("nothing consumed", lv.consumed, 0)
check("pulled = the drop", lv.pulled, 20_000)

print("\n3. The iceberg — the signal worth having")
# Shows 20k the whole way. 300k prints through it. Keeps coming back.
e = engine()
steps = [("book", Side.ASK, 102.00, 20_000, 0.0)]
for i in range(15):
    t = i + 1
    steps.append(("trade", 102.00, 20_000, t + 0.1, Aggressor.BUY))
    steps.append(("book", Side.ASK, 102.00, 20_000, t + 0.2))  # refilled
replay(e, steps)
lv = e.levels[(Side.ASK, 102.00)]
check("consumed 300k", lv.consumed, 300_000)
check("never displayed over 20k", lv.max_displayed, 20_000)
check("refreshed 300k", lv.refreshed, 300_000)
check("absorption ratio 15x", round(lv.ratio, 1), 15.0)
check("nothing looked pulled", lv.pulled, 0)
kinds = [ev.kind for ev in e.events]
check("reported as absorption", EventKind.ABSORBED in kinds, True)

print("\n4. Partial refresh — trades exceed the visible drop")
# 50k shown, 20k prints, book comes back at 45k: 20k eaten, 15k added.
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("trade", 102.00, 20_000, 1.5, Aggressor.BUY),
    ("book", Side.ASK, 102.00, 45_000, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("consumed 20k", lv.consumed, 20_000)
check("refreshed 15k", lv.refreshed, 15_000)
check("nothing pulled", lv.pulled, 0)

print("\n5. Mixed flush — some eaten, some pulled")
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("trade", 102.00, 30_000, 1.5, Aggressor.BUY),
    ("book", Side.ASK, 102.00, 0, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("consumed 30k", lv.consumed, 30_000)
check("pulled 20k", lv.pulled, 20_000)
kinds = [ev.kind for ev in e.events]
# 30/50 is 60%, under the 70% dominance bar, so neither cause is claimed.
check("no CONSUMED claim", EventKind.CONSUMED in kinds, False)
check("no PULLED claim", EventKind.PULLED in kinds, False)

print("\n6. A clean spoof reports as pulled")
e = engine()
replay(e, [
    ("book", Side.BID, 98.00, 40_000, 1.0),
    ("trade", 98.00, 2_000, 1.5, Aggressor.SELL),
    ("book", Side.BID, 98.00, 0, 2.0),
])
kinds = [ev.kind for ev in e.events]
check("PULLED emitted", EventKind.PULLED in kinds, True)
check("CONSUMED not emitted", EventKind.CONSUMED in kinds, False)

print("\n7. A wall genuinely eaten reports as consumed")
e = engine()
replay(e, [
    ("book", Side.BID, 98.00, 40_000, 1.0),
    ("trade", 98.00, 38_000, 1.5, Aggressor.SELL),
    ("book", Side.BID, 98.00, 0, 2.0),
])
kinds = [ev.kind for ev in e.events]
check("CONSUMED emitted", EventKind.CONSUMED in kinds, True)
check("PULLED not emitted", EventKind.PULLED in kinds, False)

print("\n8. Aggressor split is kept")
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("trade", 102.00, 12_000, 1.2, Aggressor.BUY),
    ("trade", 102.00, 3_000, 1.3, Aggressor.SELL),
    ("book", Side.ASK, 102.00, 35_000, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("buy volume", lv.buy_volume, 12_000)
check("sell volume", lv.sell_volume, 3_000)

print("\n9. Small levels do not generate noise")
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 900, 1.0),
    ("book", Side.ASK, 102.00, 0, 2.0),
])
check("no events under the flush floor", e.events, [])

print("\n10. Float prices snap to the tick")
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 50_000, 1.0),
    ("trade", 102.0000001, 20_000, 1.5, Aggressor.BUY),
    ("book", Side.ASK, 102.00, 30_000, 2.0),
])
lv = e.levels[(Side.ASK, 102.00)]
check("trade landed on the level", lv.consumed, 20_000)
check("only one level exists", len(e.levels), 1)

print("\n11. Absorption is not re-announced on every update")
e = engine()
steps = [("book", Side.ASK, 102.00, 20_000, 0.0)]
for i in range(20):
    steps.append(("trade", 102.00, 20_000, i + 0.1, Aggressor.BUY))
    steps.append(("book", Side.ASK, 102.00, 20_000, i + 0.2))
replay(e, steps)
n_absorbed = sum(1 for ev in e.events if ev.kind is EventKind.ABSORBED)
# 400k consumed at a 25k step = 16, not one per book update.
check("episode collapses to few events", n_absorbed <= 16, True)
check("and is not one per update", n_absorbed < 20, True)

print("\n12. Ranking puts the most absorbed level first")
e = engine()
replay(e, [
    ("book", Side.ASK, 102.00, 20_000, 1.0),
    ("trade", 102.00, 15_000, 1.1, Aggressor.BUY),
    ("book", Side.ASK, 102.00, 5_000, 1.2),
    ("book", Side.ASK, 103.00, 60_000, 1.0),
    ("trade", 103.00, 50_000, 1.1, Aggressor.BUY),
    ("book", Side.ASK, 103.00, 10_000, 1.2),
])
top = e.levels_by_absorption()[0]
check("103 ranks above 102", top.price, 103.00)

print("\n13. Thresholds scale off average trade size")
t = Thresholds.from_profile(avg_trade_size=250)
check("wall = 40x avg trade", t.min_wall_size, 10_000)
t_spy = Thresholds.from_profile(avg_trade_size=1_200)
check("bigger name, bigger wall", t_spy.min_wall_size, 48_000)

print(f"\n{'=' * 46}")
print(f"  {sum(results)}/{len(results)} checks passed")
print(f"{'=' * 46}\n")
raise SystemExit(0 if all(results) else 1)
