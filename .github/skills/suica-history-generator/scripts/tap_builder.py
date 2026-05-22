"""Tap builder: convert TimedTrips into Suica tap entries with running balance.

For each TimedTrip we emit two entries:
    入  <date> <time>  <origin_station>     残高 <balance_before>
    出  <date> <time>  <destination_station> 残高 <balance_after>  (-fare)

Free teiki rides still emit both 入 and 出 with fare=0.

Auto-topup: before each 入, if the post-trip balance would drop below the
topup threshold, insert:
    オートチャージ  <topup_amount>   <station>   残高 <new_balance>
at the same datetime as the 入 (typical Suica behavior triggers on entry).
"""
from __future__ import annotations

import logging

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

    def __init__(self, config: GeneratorConfig):
        self.config = config

    def build(self, timed_trips: list[TimedTrip], month: str) -> MonthlyHistory:
        entries: list[TapEntry] = []
        balance = self.config.initial_balance
        total_spent = 0
        total_charged = 0
        topup_rule = self.config.auto_topup

        timed_trips = sorted(timed_trips, key=lambda x: x.tap_in_at)

        for trip in timed_trips:
            # Auto-topup check: if balance after this trip's fare < threshold,
            # charge BEFORE the tap-in.
            if balance - trip.fare_yen < topup_rule.threshold:
                balance += topup_rule.amount
                total_charged += topup_rule.amount
                entries.append(TapEntry(
                    kind=TapKind.AUTO,
                    at=trip.tap_in_at,
                    station=trip.plan.origin,
                    fare_yen=topup_rule.amount,
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

        return MonthlyHistory(
            month=month,
            initial_balance=self.config.initial_balance,
            final_balance=balance,
            total_spent=total_spent,
            total_charged=total_charged,
            entries=entries,
        )
