"""Tap builder: convert TimedTrips into Suica tap entries with running balance.

For each TimedTrip we emit two entries:
    入  <date> <time>  <origin_station>     残高 <balance_before>
    出  <date> <time>  <destination_station> 残高 <balance_after>  (-fare)

Free teiki rides still emit both 入 and 出 with fare=0.

Auto-topup: before each 入, if the post-trip balance would drop below the
topup threshold, insert:
    オートチャージ  <topup_amount>   <station>   残高 <new_balance>
at the same datetime as the 入 (typical Suica behavior triggers on entry).

If `config.shopping.enabled` is True, the builder also sprinkles 物販 events
through the month at random times — these add realism (real statements always
mix purchases with train trips) and are deterministic when an `rng` is passed.
"""
from __future__ import annotations

import datetime as dt
import logging
import random

from .models import (
    GeneratorConfig,
    MonthlyHistory,
    TapEntry,
    TapKind,
    TimedTrip,
)

log = logging.getLogger(__name__)


class TapBuilder:
    """Phase 2.4 + 2.5 — emits TapEntry rows and manages balance + auto-topup."""

    def __init__(self, config: GeneratorConfig, rng: random.Random | None = None):
        self.config = config
        # Use a dedicated child Random so we don't perturb the global rng state
        # used by other pipeline stages (timing, leisure picks). Passing the
        # same seed to TapBuilder still produces deterministic output.
        if rng is None:
            self._rng = random.Random()
        else:
            self._rng = random.Random(rng.random())

    # ------------------------------------------------------------------

    def _pick_topup_amount(self) -> int:
        choices = self.config.auto_topup.amount_choices
        if choices:
            return self._rng.choice(choices)
        return self.config.auto_topup.amount

    def _generate_shopping_events(self, month: str, trips: list[TimedTrip]) -> list[tuple[dt.datetime, int]]:
        """Return (datetime, amount) tuples for 物販 events to interleave.
        Events are scheduled in gaps BETWEEN trips so the final entry list stays
        strictly chronological even when a shopping event lands on the same
        afternoon as a commute trip."""
        spec = self.config.shopping
        if not spec.enabled or not trips:
            return []
        lo, hi = spec.monthly_count
        n = self._rng.randint(lo, hi)
        if n <= 0:
            return []

        # Build sorted list of "blocked" intervals (tap_in → tap_out) so we can
        # avoid placing shopping events inside an active trip window.
        blocks = sorted(((t.tap_in_at, t.tap_out_at) for t in trips), key=lambda x: x[0])
        first = trips[0].tap_in_at.date()
        last = trips[-1].tap_in_at.date()
        days = max(1, (last - first).days + 1)

        events: list[tuple[dt.datetime, int]] = []
        for _ in range(n):
            # Try a few candidate times to avoid landing inside a trip
            placed: dt.datetime | None = None
            for _attempt in range(8):
                day_offset = self._rng.randrange(days)
                d = first + dt.timedelta(days=day_offset)
                hour = self._rng.randint(11, 22)
                minute = self._rng.randint(0, 59)
                cand = dt.datetime.combine(d, dt.time(hour, minute))
                # Reject if inside any trip window (±1 minute padding)
                if any(b[0] - dt.timedelta(minutes=1) <= cand <= b[1] + dt.timedelta(minutes=1)
                       for b in blocks):
                    continue
                placed = cand
                break
            if placed is None:
                continue  # gave up — fewer shopping events that month
            amt = self._rng.choice(spec.amount_choices)
            events.append((placed, amt))
        events.sort(key=lambda x: x[0])
        return events

    def build(self, timed_trips: list[TimedTrip], month: str) -> MonthlyHistory:
        entries: list[TapEntry] = []
        balance = self.config.initial_balance
        total_spent = 0
        total_charged = 0
        topup_rule = self.config.auto_topup

        timed_trips = sorted(timed_trips, key=lambda x: x.tap_in_at)
        shopping_events = self._generate_shopping_events(month, timed_trips)
        shop_idx = 0

        def flush_shopping_up_to(when: dt.datetime) -> None:
            """Emit any 物販 events that occur at or before `when` AND after the
            most recently emitted entry's time (to preserve chronological order)."""
            nonlocal shop_idx, balance, total_spent
            last_at = entries[-1].at if entries else None
            while shop_idx < len(shopping_events) and shopping_events[shop_idx][0] <= when:
                s_at, s_amt = shopping_events[shop_idx]
                if last_at is not None and s_at < last_at:
                    # Skip events that would break chronological order — they
                    # were filtered against trip windows at generation time but
                    # the chosen `when` boundary may still leave a sub-minute
                    # overlap (e.g., AUTO inserted at the same minute as IN).
                    shop_idx += 1
                    continue
                # If insufficient balance, top up first (same rule as trips)
                if balance - s_amt < topup_rule.threshold:
                    charge = self._pick_topup_amount()
                    balance += charge
                    nonlocal_charged[0] += charge
                    entries.append(TapEntry(
                        kind=TapKind.AUTO,
                        at=s_at,
                        station="モバイル",
                        fare_yen=charge,
                        balance_yen=balance,
                    ))
                balance -= s_amt
                total_spent += s_amt
                entries.append(TapEntry(
                    kind=TapKind.SHOPPING,
                    at=s_at,
                    station=self.config.shopping.merchant_label,
                    fare_yen=s_amt,
                    balance_yen=balance,
                ))
                last_at = s_at
                shop_idx += 1

        # Workaround for `nonlocal` int (need mutable container for total_charged
        # inside the nested function — Python closure semantics).
        nonlocal_charged = [total_charged]

        for trip in timed_trips:
            # Drain shopping events scheduled before this trip's tap-in
            flush_shopping_up_to(trip.tap_in_at - dt.timedelta(seconds=1))
            # Auto-topup check: if balance after this trip's fare < threshold,
            # charge BEFORE the tap-in.
            if balance - trip.fare_yen < topup_rule.threshold:
                charge = self._pick_topup_amount()
                balance += charge
                nonlocal_charged[0] += charge
                entries.append(TapEntry(
                    kind=TapKind.AUTO,
                    at=trip.tap_in_at,
                    station=trip.plan.origin,
                    fare_yen=charge,
                    balance_yen=balance,
                ))

            # Tap-in
            entries.append(TapEntry(
                kind=TapKind.IN,
                at=trip.tap_in_at,
                station=trip.plan.origin,
                fare_yen=0,
                balance_yen=balance,
            ))

            # Tap-out (fare deducted)
            balance -= trip.fare_yen
            total_spent += trip.fare_yen
            entries.append(TapEntry(
                kind=TapKind.OUT,
                at=trip.tap_out_at,
                station=trip.plan.destination,
                fare_yen=trip.fare_yen,
                balance_yen=balance,
            ))

        # Drain any remaining shopping events after the last trip
        if timed_trips:
            flush_shopping_up_to(dt.datetime.max)

        total_charged = nonlocal_charged[0]

        return MonthlyHistory(
            month=month,
            initial_balance=self.config.initial_balance,
            final_balance=balance,
            total_spent=total_spent,
            total_charged=total_charged,
            entries=entries,
        )
