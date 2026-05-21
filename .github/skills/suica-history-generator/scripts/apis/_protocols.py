"""Common types and protocols shared by all API clients."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class Station:
    """A train station, normalized across providers."""

    code: str                  # ekidata station_cd, e.g. "1130101"
    name_kanji: str            # "東京"
    name_kana: str = ""        # "とうきょう"
    lat: float = 0.0
    lon: float = 0.0
    line_codes: tuple[str, ...] = ()
    operators: tuple[str, ...] = ()  # ("JR東日本",)

    def display(self) -> str:
        return self.name_kanji


@dataclass(frozen=True, slots=True)
class TransitStep:
    """One leg of a route (e.g., JR山手線 from 東京 to 新宿)."""

    from_station: str
    to_station: str
    line_name: str
    operator: str
    duration_min: int = 0


@dataclass(frozen=True, slots=True)
class Route:
    """A full origin->destination journey."""

    from_station: str
    to_station: str
    steps: tuple[TransitStep, ...] = ()
    ic_fare_yen: int = 0
    duration_min: int = 0
    provider: str = ""           # which API resolved this
    in_gate: str = ""            # usually == from_station
    out_gate: str = ""           # usually == to_station

    def __post_init__(self):
        # Default gates if not specified
        if not self.in_gate:
            object.__setattr__(self, "in_gate", self.from_station)
        if not self.out_gate:
            object.__setattr__(self, "out_gate", self.to_station)


@dataclass(slots=True)
class FareQuote:
    """A fare estimate from a single provider, used for cross-validation."""

    provider: str
    ic_fare_yen: int
    confidence: float = 1.0       # 0..1; 1 means provider claims authoritative
    notes: str = ""


class StationProvider(Protocol):
    """Find a station by name."""

    name: str

    def find_station(self, name: str, limit: int = 5) -> list[Station]: ...


class FareProvider(Protocol):
    """Look up a single IC fare for a given OD pair."""

    name: str

    def quote_fare(self, origin: Station, dest: Station) -> FareQuote | None: ...


class RouteProvider(Protocol):
    """Resolve a full route (legs + transfers + fare)."""

    name: str

    def resolve_route(self, origin: Station, dest: Station) -> Route | None: ...
