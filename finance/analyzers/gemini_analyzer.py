"""
Gemini AI Analyzer - Uses Google Gemini to extract structured signals from news articles.
Gemini is used as an EXTRACTION layer only; scoring logic is deterministic in factor_scorer.py.
"""
import hashlib
import json
import logging
import time
from typing import Optional

from google import genai
from google.genai import types

from config import GEMINI_API_KEY, GEMINI_MODEL, MAX_ARTICLES_TO_GEMINI, FACTOR_GROUPS
from crawlers.base import Article

logger = logging.getLogger("jpy_forecast")

EXTRACTION_PROMPT = """Bạn là chuyên gia phân tích tài chính chuyên về đồng Yên Nhật (JPY), thị trường ngoại hối, và đặc biệt là tỷ giá JPY/VND.

Phân tích các bài báo dưới đây và trích xuất tín hiệu có cấu trúc về biến động JPY.

Với mỗi bài báo liên quan, trích xuất:
1. **factor**: Nhóm yếu tố (một trong: {factors})
2. **direction**: Tác động lên JPY ("stronger" = JPY tăng giá, "weaker" = JPY giảm giá, "neutral")
3. **magnitude**: Mức độ tác động ("high", "medium", "low")
4. **evidence**: Trích dẫn/dữ kiện chính từ bài báo (1 câu)
5. **time_relevance**: "immediate" (hôm nay), "short_term" (tuần này), "medium_term" (tháng này)
6. **title_vi**: Dịch tiêu đề bài báo sang TIẾNG VIỆT, ngắn gọn, tự nhiên

Ngoài ra, cung cấp:
- **market_summary**: Tóm tắt 3-4 câu BẰNG TIẾNG VIỆT về tình hình thị trường ảnh hưởng tới JPY
- **vnd_analysis**: Phân tích 2-3 câu BẰNG TIẾNG VIỆT về tác động lên tỷ giá JPY/VND (1 Yên = ? Đồng). Xét cả: chính sách NHNN Việt Nam, chênh lệch lãi suất VN-Nhật, dòng vốn FDI Nhật vào VN, lạm phát VN
- **vnd_direction**: Dự đoán JPY/VND sẽ ("up" = 1 JPY mua được nhiều VND hơn, "down" = 1 JPY mua được ít VND hơn, "sideways")
- **key_risks**: Top 3 rủi ro BẰNG TIẾNG VIỆT có thể gây biến động JPY bất ngờ
- **overall_bias**: Đánh giá hướng đi JPY ("stronger", "weaker", "neutral")
- **confidence**: Mức độ tự tin (0.0 đến 1.0)

QUAN TRỌNG:
- Tập trung vào SỰ KIỆN, không suy đoán
- Nếu thông tin mâu thuẫn, ghi nhận cả hai phía
- Phân biệt rõ giữa đã xảy ra vs có thể xảy ra
- Nêu rõ mức độ không chắc chắn
- TẤT CẢ nội dung phân tích phải bằng TIẾNG VIỆT

Các bài báo cần phân tích:
{articles}

Trả lời CHỈ bằng JSON hợp lệ theo đúng format sau:
{{
  "signals": [
    {{
      "article_title": "...(tiêu đề gốc tiếng Anh)...",
      "title_vi": "...(tiêu đề dịch sang tiếng Việt)...",
      "factor": "monetary_policy|japan_domestic|external_balance|risk_sentiment|intervention_political",
      "direction": "stronger|weaker|neutral",
      "magnitude": "high|medium|low",
      "evidence": "...(bằng tiếng Việt)...",
      "time_relevance": "immediate|short_term|medium_term"
    }}
  ],
  "market_summary": "...(tiếng Việt)...",
  "vnd_analysis": "...(tiếng Việt, phân tích JPY/VND)...",
  "vnd_direction": "up|down|sideways",
  "key_risks": ["...(tiếng Việt)...", "...", "..."],
  "overall_bias": "stronger|weaker|neutral",
  "confidence": 0.0
}}"""


def _prepare_articles_text(articles: list[Article]) -> str:
    """Format articles for the prompt, respecting token limits."""
    # Sort by source priority and deduplicate
    seen = set()
    unique = []
    for a in articles:
        if a.content_hash not in seen:
            seen.add(a.content_hash)
            unique.append(a)

    # Cap at MAX_ARTICLES_TO_GEMINI
    capped = unique[:MAX_ARTICLES_TO_GEMINI]

    lines = []
    for i, a in enumerate(capped, 1):
        lines.append(f"[{i}] Source: {a.source}")
        lines.append(f"    Title: {a.title}")
        if a.summary:
            lines.append(f"    Summary: {a.summary[:300]}")
        lines.append(f"    Published: {a.published_at}")
        lines.append("")

    return "\n".join(lines)


def analyze_with_gemini(articles: list[Article]) -> Optional[dict]:
    """
    Send articles to Gemini for structured signal extraction.
    Returns parsed JSON dict or None on failure.
    """
    if not GEMINI_API_KEY:
        logger.error("[gemini] GEMINI_API_KEY not set!")
        return None

    if not articles:
        logger.warning("[gemini] No articles to analyze")
        return None

    client = genai.Client(api_key=GEMINI_API_KEY)

    factor_names = "|".join(FACTOR_GROUPS.keys())
    articles_text = _prepare_articles_text(articles)

    prompt = EXTRACTION_PROMPT.format(
        factors=factor_names,
        articles=articles_text,
    )

    prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()[:16]

    # Try models in order: primary, then fallbacks
    models_to_try = [GEMINI_MODEL, "gemini-2.0-flash-lite", "gemini-2.5-flash"]
    max_retries = 3
    retry_delay = 20  # seconds

    response = None
    used_model = GEMINI_MODEL

    for model_name in models_to_try:
        for attempt in range(max_retries):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.3,
                    ),
                )
                used_model = model_name
                break
            except Exception as e:
                error_str = str(e)
                if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
                    wait = retry_delay * (attempt + 1)
                    logger.warning(f"[gemini] Rate limited on {model_name}, retry {attempt+1}/{max_retries} in {wait}s...")
                    time.sleep(wait)
                else:
                    logger.warning(f"[gemini] Error with {model_name}: {e}")
                    break
        if response:
            break

    if not response:
        logger.error("[gemini] All models and retries exhausted")
        return None

    try:

        raw_text = response.text.strip()

        # Parse JSON
        try:
            result = json.loads(raw_text)
        except json.JSONDecodeError:
            # Try extracting JSON from markdown code block
            if "```json" in raw_text:
                raw_text = raw_text.split("```json")[1].split("```")[0].strip()
            elif "```" in raw_text:
                raw_text = raw_text.split("```")[1].split("```")[0].strip()
            result = json.loads(raw_text)

        # Validate structure
        if "signals" not in result:
            result["signals"] = []
        if "overall_bias" not in result:
            result["overall_bias"] = "neutral"
        if "confidence" not in result:
            result["confidence"] = 0.3

        logger.info(f"[gemini] Analyzed {len(articles)} articles → {len(result.get('signals', []))} signals")

        # Attach metadata for auditing
        result["_meta"] = {
            "prompt_hash": prompt_hash,
            "model": used_model,
            "article_count": len(articles),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        return result

    except Exception as e:
        logger.error(f"[gemini] Analysis failed: {e}")
        return None


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # Test with sample articles
    test_articles = [
        Article(
            source="test",
            title="BOJ considers raising interest rates in next meeting",
            summary="Bank of Japan officials hint at possible rate increase due to rising inflation.",
        ),
        Article(
            source="test",
            title="US Fed holds rates steady, signals potential cuts",
            summary="Federal Reserve keeps rates unchanged but hints at rate cuts later this year.",
        ),
    ]
    result = analyze_with_gemini(test_articles)
    if result:
        print(json.dumps(result, indent=2, ensure_ascii=False))
