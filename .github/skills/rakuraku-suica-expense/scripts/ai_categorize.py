"""AI auto-categorize Suica trips for Rakuraku Seisan expense filing.

Annotates trips.json with category/purpose/include/confidence using
GitHub Models (gpt-4o-mini). Batches trips to minimize API calls.

Usage:
    python ai_categorize.py --input trips.json [--output trips_annotated.json]
    python ai_categorize.py --input trips.json --dry-run
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BATCH_SIZE = 50
API_URL = "https://models.inference.ai.azure.com/chat/completions"
TIMEOUT_SEC = 60

SYSTEM_PROMPT = """\
Bạn là expense categorization assistant cho TanVC tại FJP (Japan).
Phân loại các chuyến tàu Suica thành: commute / personal / business / unknown.

Quy tắc:
- Weekday (月〜金) 07:00-10:00 đi từ nhà → office area: commute
- Weekday 17:00-21:00 về nhà (chiều ngược lại): commute
- Recurring cùng from/to nhiều ngày weekday: commute (confidence cao)
- Weekend (土/日): personal (trừ khi pattern rõ là business trip)
- One-off destinations lạ: unknown (confidence < 0.7)
- Lunch trips (11:00-14:00 weekday, quay về cùng station): personal, include=false

Output STRICT JSON array only, KHÔNG markdown wrap, KHÔNG explanation:
[{"idx": 0, "category": "commute", "purpose": "通勤 (Tokyo→Shinjuku)", "include": true, "confidence": 0.95}, ...]

Trường "purpose" PHẢI bằng tiếng Nhật vì sẽ paste thẳng vào Rakuraku 用途 field.
Ví dụ purpose: "通勤 (Tokyo→Shinjuku)", "通勤 (帰宅)", "週末私用", "業務出張", "不明（要確認）"

Trường "include":
- true = file as expense (commute, business)
- false = do NOT file (personal, weekend leisure)
"""


# ---------------------------------------------------------------------------
# AI call
# ---------------------------------------------------------------------------


def build_user_message(trips: list[dict], batch_offset: int) -> str:
    """Build user message with trip list for AI."""
    lines = ["以下のSuica乗車履歴を分類してください:\n"]
    for i, t in enumerate(trips):
        idx = batch_offset + i
        lines.append(
            f"[{idx}] {t.get('date','')} ({t.get('weekday','')}) "
            f"{t.get('time', t.get('from',''))} "
            f"{'→ ' + t.get('to','') if 'from' in t and 'to' in t else ''} "
            f"¥{t.get('amount', t.get('fare', 0))}"
        )
        # Include from/to explicitly if time field exists separately
        if 'from' in t and 'to' in t and 'time' not in t:
            pass  # already included above
        elif 'from' in t and 'to' in t:
            lines[-1] = (
                f"[{idx}] {t.get('date','')} ({t.get('weekday','')}) "
                f"{t.get('time','')} {t.get('from','')}→{t.get('to','')} "
                f"¥{t.get('amount', t.get('fare', 0))}"
            )
    return "\n".join(lines)


def call_ai(trips: list[dict], batch_offset: int, model: str, token: str) -> list[dict]:
    """Call GitHub Models API and return annotations list."""
    user_msg = build_user_message(trips, batch_offset)

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.1,
        "max_tokens": 4096,
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    resp = urllib.request.urlopen(req, timeout=TIMEOUT_SEC)
    body = json.loads(resp.read().decode("utf-8"))

    content = body["choices"][0]["message"]["content"].strip()
    # Strip markdown code fences if AI wraps anyway
    if content.startswith("```"):
        content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

    return json.loads(content)


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------

SAFE_DEFAULTS = {
    "category": "unknown",
    "purpose": "不明（要確認）",
    "include": True,
    "confidence": 0.0,
}


def merge_annotations(trips: list[dict], annotations: list[dict]) -> list[dict]:
    """Merge AI annotations into trips by idx. Missing entries get safe defaults."""
    ann_map: dict[int, dict] = {}
    for a in annotations:
        if isinstance(a, dict) and "idx" in a:
            ann_map[int(a["idx"])] = a

    result = []
    for i, trip in enumerate(trips):
        merged = dict(trip)
        ann = ann_map.get(i, {})
        for key in ("category", "purpose", "include", "confidence"):
            merged[key] = ann.get(key, SAFE_DEFAULTS[key])
        # Validate types
        if merged["category"] not in ("commute", "personal", "business", "unknown"):
            merged["category"] = "unknown"
            merged["confidence"] = 0.0
        if not isinstance(merged["include"], bool):
            merged["include"] = True
        if not isinstance(merged["confidence"], (int, float)):
            merged["confidence"] = 0.0
        result.append(merged)

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def categorize(
    input_path: Path,
    output_path: Path,
    model: str,
    batch_size: int,
    dry_run: bool,
) -> list[dict]:
    """Main categorization pipeline."""
    with open(input_path, "r", encoding="utf-8") as f:
        trips = json.load(f)

    if not isinstance(trips, list):
        print("ERROR: trips.json must be a JSON array", file=sys.stderr)
        sys.exit(1)

    token = os.environ.get("GH_PAT", "")
    if not token:
        print("WARNING: GH_PAT not set — writing safe defaults for all trips.",
              file=sys.stderr)
        annotated = [{**t, **SAFE_DEFAULTS} for t in trips]
    else:
        all_annotations: list[dict] = []
        for start in range(0, len(trips), batch_size):
            batch = trips[start:start + batch_size]
            print(f"  → Calling AI for trips [{start}..{start+len(batch)-1}]...")
            try:
                batch_ann = call_ai(batch, start, model, token)
                all_annotations.extend(batch_ann)
            except (urllib.error.URLError, json.JSONDecodeError, KeyError, IndexError) as e:
                print(f"  ⚠️ AI call failed: {e}. Using safe defaults for this batch.",
                      file=sys.stderr)
                for i in range(start, start + len(batch)):
                    all_annotations.append({"idx": i, **SAFE_DEFAULTS})

        annotated = merge_annotations(trips, all_annotations)

    # Summary
    counts = {"commute": 0, "personal": 0, "business": 0, "unknown": 0}
    low_conf = 0
    for t in annotated:
        cat = t.get("category", "unknown")
        counts[cat] = counts.get(cat, 0) + 1
        if t.get("confidence", 0) < 0.7:
            low_conf += 1

    print(f"\nCategorized {len(annotated)} trips: "
          f"commute={counts['commute']}, personal={counts['personal']}, "
          f"business={counts['business']}, unknown={counts['unknown']}. "
          f"Low confidence (<0.7): {low_conf} trips.")

    if dry_run:
        print("\n[DRY RUN] Would write to:", output_path)
        print(json.dumps(annotated[:3], ensure_ascii=False, indent=2))
        if len(annotated) > 3:
            print(f"  ... and {len(annotated)-3} more")
    else:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(annotated, f, ensure_ascii=False, indent=2)
        print(f"Written: {output_path}")

    return annotated


def main():
    parser = argparse.ArgumentParser(
        description="AI auto-categorize Suica trips for Rakuraku expense filing"
    )
    parser.add_argument("--input", "-i", required=True, help="Path to trips.json")
    parser.add_argument("--output", "-o", default=None,
                        help="Output path (default: <input>_annotated.json)")
    parser.add_argument("--model", default=None,
                        help=f"AI model (default: env AI_MODEL or {DEFAULT_MODEL})")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                        help=f"Max trips per AI call (default: {DEFAULT_BATCH_SIZE})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print results without writing output file")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_name(
            input_path.stem + "_annotated" + input_path.suffix
        )

    model = args.model or os.environ.get("AI_MODEL", DEFAULT_MODEL)

    categorize(input_path, output_path, model, args.batch_size, args.dry_run)


if __name__ == "__main__":
    main()
