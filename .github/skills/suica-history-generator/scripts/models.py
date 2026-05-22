"""Pydantic models for the generator pipeline.

Pipeline data flow:
    Config (preset JSON)
       └─ TripScheduler.plan() ──▶ [PlannedTrip]
                                       └─ BudgetAllocator.adjust() ──▶ [PlannedTrip]
                                                                          └─ TimingEngine.assign_times() ──▶ [TimedTrip]
                                                                                                                └─ TapBuilder.build() ──▶ MonthlyHistory
"""
from __future__ import annotations

import datetime as dt
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# ----------------------------------------------------------------------
# Config models (preset JSON)
# ----------------------------------------------------------------------


class TripType(str, Enum):
    COMMUTE  = "commute"   # daily home↔office, can be covered by teiki
    LEISURE  = "leisure"   # weekend / casual
    BUSINESS = "business"  # client visit, full fare


class WeeklySlot(BaseModel):
    route: str           # "A↔B" — convention: A=home/origin, B=destination
    type: TripType = TripType.COMMUTE


class LeisureCandidate(BaseModel):
    route: str
    weight: int = Field(default=1, ge=1)


class TeikiPass(BaseModel):
    route: str
    valid_from: dt.date
    valid_to: dt.date

    def covers(self, route: str, on: dt.date) -> bool:
        return self.route == route and self.valid_from <= on <= self.valid_to


class TopupRule(BaseModel):
    threshold: int = 1500   # if balance projected < threshold
    amount:    int = 3000   # default オートチャージ amount
    # If non-empty, each top-up picks a random value from this list instead
    # of always using `amount`. Real Mobile Suica users charge varied amounts
    # (¥500/¥1,000/¥1,500/¥2,000/¥3,000…), so a fixed ¥3,000 every time looks
    # mechanical and is a tell-tale sign of generated data.
    amount_choices: list[int] = Field(default_factory=lambda: [500, 1000, 1500, 2000, 3000])


class ShoppingSpec(BaseModel):
    """物販 (vending / convenience-store purchase) events sprinkled randomly
    through the month. Real Mobile Suica statements always have these mixed in
    with train trips; without them, the output looks like commute-only data
    which is an obvious tell. Set `enabled=False` to disable."""

    enabled: bool = True
    monthly_count: tuple[int, int] = (4, 10)
    amount_choices: list[int] = Field(default_factory=lambda: [
        110, 130, 150, 180, 220, 250, 320, 400, 480,
        580, 704, 980, 1100, 1400, 1880, 2400, 2610,
    ])
    merchant_label: str = "モバイル"


class TimingSpec(BaseModel):
    morning_commute: dict = Field(default_factory=lambda: {"base": "08:30", "sigma_min": 8})
    evening_commute: dict = Field(default_factory=lambda: {"base": "19:00", "sigma_min": 15})
    weekend_leisure: dict = Field(default_factory=lambda: {"window": ["10:00", "20:00"]})
    lunch:           dict = Field(default_factory=lambda: {"base": "12:15", "sigma_min": 10})


WEEKDAY_NAMES = ("monday","tuesday","wednesday","thursday","friday","saturday","sunday")


class GeneratorConfig(BaseModel):
    initial_balance: int = 3000
    auto_topup: TopupRule = Field(default_factory=TopupRule)
    teiki: list[TeikiPass] = Field(default_factory=list)
    weekly_pattern: dict[str, list[WeeklySlot]] = Field(default_factory=dict)
    leisure_pool: list[LeisureCandidate] = Field(default_factory=list)
    leisure_monthly_count: tuple[int, int] = (2, 4)
    off_days: list[dt.date] = Field(default_factory=list)
    timing: TimingSpec = Field(default_factory=TimingSpec)
    shopping: ShoppingSpec = Field(default_factory=ShoppingSpec)

    @field_validator("weekly_pattern")
    @classmethod
    def _normalize_weekdays(cls, v: dict) -> dict:
        return {k.lower(): val for k, val in v.items() if k.lower() in WEEKDAY_NAMES}


# ----------------------------------------------------------------------
# Intermediate plan models
# ----------------------------------------------------------------------


class PlannedTrip(BaseModel):
    """A trip scheduled for a date, BEFORE timing assignment."""

    date: dt.date
    route: str            # "東京↔新宿"
    trip_type: TripType
    direction: Literal["outbound", "return"] = "outbound"
    # Direction note: a commute "東京↔新宿" yields TWO PlannedTrip rows:
    #   outbound: 東京→新宿 in the morning
    #   return:   新宿→東京 in the evening
    # Leisure trips also default to round-trip (outbound + return).

    @property
    def origin(self) -> str:
        a, b = self.route.split("↔", 1)
        return a if self.direction == "outbound" else b

    @property
    def destination(self) -> str:
        a, b = self.route.split("↔", 1)
        return b if self.direction == "outbound" else a


class TimedTrip(BaseModel):
    """A PlannedTrip after timing assignment."""

    plan: PlannedTrip
    tap_in_at:  dt.datetime
    tap_out_at: dt.datetime
    fare_yen:   int        # 0 if covered by teiki

    @property
    def is_free(self) -> bool:
        return self.fare_yen == 0


# ----------------------------------------------------------------------
# Output models
# ----------------------------------------------------------------------


class TapKind(str, Enum):
    IN      = "入"
    OUT     = "出"
    AUTO    = "オートチャージ"
    SHOPPING = "物販"
    BUS     = "バス"


class TapEntry(BaseModel):
    """One row of the Suica statement."""

    kind: TapKind
    at: dt.datetime
    station: str          # 駅 or merchant name
    fare_yen: int         # always positive; for AUTO/SHOPPING this is the amount
    balance_yen: int      # running balance after this entry

    def to_dict(self) -> dict:
        return {
            "kind": self.kind.value,
            "datetime": self.at.isoformat(),
            "station": self.station,
            "fare_yen": self.fare_yen,
            "balance_yen": self.balance_yen,
        }


class MonthlyHistory(BaseModel):
    """Final output: month's worth of Suica activity."""

    month: str            # "2026-05"
    initial_balance: int
    final_balance: int
    total_spent: int      # sum of fare_yen for IN→OUT pairs and 物販
    total_charged: int    # sum of オートチャージ amounts
    entries: list[TapEntry]

    def to_csv_rows(self) -> list[dict]:
        return [e.to_dict() for e in self.entries]

    def summary(self) -> str:
        return (
            f"=== Suica history for {self.month} ===\n"
            f"  Entries:        {len(self.entries)}\n"
            f"  Initial balance: ¥{self.initial_balance:,}\n"
            f"  Total spent:     ¥{self.total_spent:,}\n"
            f"  Total charged:   ¥{self.total_charged:,}\n"
            f"  Final balance:   ¥{self.final_balance:,}"
        )
