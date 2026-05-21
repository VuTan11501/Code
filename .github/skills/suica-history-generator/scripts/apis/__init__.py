"""API client implementations for free Japan public transit data sources.

Tier order (cheapest -> fallback):
1. local SQLite cache (instant, free)
2. odpt.org              (free, key required, Tokyo metropolitan)
3. HeartRails Express    (free, no key, nationwide stations)
4. ekidata.jp            (free, bulk CSV pre-import, nationwide)
5. Google Directions     (paid but $200 free/mo, last resort)

All clients implement the FareProvider / StationProvider protocols
declared in `_protocols.py` so callers can mix-and-match.
"""
