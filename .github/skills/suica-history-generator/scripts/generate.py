"""generate.py — CLI orchestrator for the Suica history generator.

End-to-end pipeline:

    preset.json  ─▶  GeneratorConfig
                          │
                          ▼
    TripScheduler.plan_month(month) ─▶ [PlannedTrip]
                          │
                          ▼
    RouteResolver.resolve(route)  ◀─ for each unique route
                          │
                          ▼
    BudgetAllocator.adjust(target) ─▶ [PlannedTrip]
                          │
                          ▼
    TimingEngine.assign() ─────────▶ [TimedTrip]
                          │
                          ▼
    TapBuilder.build() ────────────▶ MonthlyHistory
                          │
                          ▼
    Write JSON / CSV / PDF (TODO Phase 3)

CLI:
    python -m scripts.generate \
        --config data/presets/tokyo-commuter.json \
        --month 2026-05 \
        --target 25000 \
        --seed 42 \
        --out out/may.json
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import random
import sys
from pathlib import Path

from .budget_allocator import BudgetAllocator
from .models import GeneratorConfig, MonthlyHistory, PlannedTrip
from .route_resolver import ResolveResult, RouteResolver
from .tap_builder import TapBuilder
from .timing_engine import TimingEngine
from .trip_scheduler import TripScheduler

log = logging.getLogger("generate")


def load_config(path: Path) -> GeneratorConfig:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    raw.pop("_meta", None)
    return GeneratorConfig.model_validate(raw)


class FareCache:
    """Resolves a route name (e.g., '東京↔新宿') to per-leg IC fare, with caching."""

    def __init__(self, resolver: RouteResolver):
        self._resolver = resolver
        self._cache: dict[str, ResolveResult] = {}

    def resolve_route(self, route_name: str) -> ResolveResult:
        if route_name not in self._cache:
            a, b = route_name.split("↔", 1)
            self._cache[route_name] = self._resolver.resolve(a, b)
            r = self._cache[route_name]
            log.info("  %s: ¥%d  (%s)", route_name, r.consensus_fare, r.route.provider)
            for w in r.warnings:
                log.warning("    ⚠ %s", w)
        return self._cache[route_name]

    def fare_for_trip(self, trip: PlannedTrip) -> int:
        return self.resolve_route(trip.route).consensus_fare

    def duration_for_trip(self, trip: PlannedTrip) -> int:
        return self.resolve_route(trip.route).route.duration_min


def write_outputs(history: MonthlyHistory, out_path: Path,
                  template_pdf: Path | None = None,
                  validate: bool = True) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = out_path.suffix.lower()

    if validate:
        from .validator import validate as run_validate
        report = run_validate(history)
        if report.errors:
            log.error("Validation FAILED with %d errors:\n%s",
                      len(report.errors), report.summary())
            sys.exit(3)
        if report.warnings:
            log.warning("Validation produced %d warnings", len(report.warnings))

    if suffix in ("", ".json"):
        out_path.write_text(
            json.dumps(history.model_dump(), ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        log.info("Wrote JSON → %s", out_path)
    elif suffix == ".csv":
        with open(out_path, "w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["kind", "datetime", "station", "fare_yen", "balance_yen"])
            writer.writeheader()
            for e in history.entries:
                writer.writerow(e.to_dict())
        log.info("Wrote CSV → %s", out_path)
    elif suffix == ".pdf":
        if template_pdf is None or not Path(template_pdf).exists():
            log.error("PDF output requires --template <real-suica.pdf>")
            sys.exit(2)
        from .pdf_export import PdfExporter
        exporter = PdfExporter(str(template_pdf))
        stats = exporter.render(history, str(out_path))
        log.info("Wrote PDF → %s (rendered %d/%d rows, cleared %d, truncated %d)",
                 out_path, stats["rendered"], stats["template_rows"],
                 stats["cleared"], stats["truncated"])
    else:
        log.error("Unsupported output suffix: %s", suffix)
        sys.exit(2)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Generate a realistic Suica history.")
    p.add_argument("--config", type=Path, required=True, help="Preset JSON path")
    p.add_argument("--month", required=True, help="YYYY-MM")
    p.add_argument("--target", type=int, required=True, help="Target ¥ amount for the month")
    p.add_argument("--tolerance", type=int, default=500, help="Allowed ± deviation from target (¥)")
    p.add_argument("--seed", type=int, default=None, help="Reproducibility seed")
    p.add_argument("--out", type=Path, default=Path("out/history.json"), help="Output file (.json/.csv/.pdf)")
    p.add_argument("--template", type=Path, default=None, help="Template Suica PDF (required for --out *.pdf)")
    p.add_argument("--rakuraku-out", type=Path, default=None,
                   help="Also emit a rakuraku-suica-expense trips.json at this path")
    p.add_argument("--no-validate", action="store_true", help="Skip validator pass")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )
    rng = random.Random(args.seed)

    log.info("Loading config %s", args.config)
    config = load_config(args.config)

    log.info("Resolving route fares...")
    resolver = RouteResolver()
    cache = FareCache(resolver)

    log.info("Step 1: scheduling trips for %s", args.month)
    plans = TripScheduler(config, rng).plan_month(args.month)

    # Prime fare cache so adjust() can look up fares synchronously
    for t in plans:
        cache.fare_for_trip(t)

    log.info("Step 2: adjusting to target ¥%d ±¥%d", args.target, args.tolerance)
    plans = BudgetAllocator(config, rng, tolerance_yen=args.tolerance).adjust(
        plans, args.target, cache.fare_for_trip,
    )
    # Ensure any new (added) leisure routes have fares cached too
    for t in plans:
        cache.fare_for_trip(t)

    log.info("Step 3: assigning timestamps")
    timed = TimingEngine(config, rng).assign(plans, cache.fare_for_trip, cache.duration_for_trip)

    log.info("Step 4: building Suica taps")
    history = TapBuilder(config).build(timed, args.month)

    print(history.summary())
    write_outputs(history, args.out, template_pdf=args.template,
                  validate=not args.no_validate)
    if args.rakuraku_out:
        from .rakuraku_export import write_trips_json
        stats = write_trips_json(history, args.rakuraku_out)
        log.info("Rakuraku trips → %s (%d trips, ¥%s)",
                 args.rakuraku_out, stats["count"], f"{stats['total_yen']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
