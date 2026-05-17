"""
Technical Features — Compute technical analysis indicators from OHLC data.
All indicators computed with pure pandas/numpy (no external TA lib needed).
Used by ml_predictor.py for training and daily prediction.
"""
import logging
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

logger = logging.getLogger("jpy_forecast")


def fetch_ohlc(symbol: str = "USDJPY=X", years: int = 5) -> pd.DataFrame:
    """Fetch daily OHLC from Yahoo Finance."""
    end = datetime.now()
    start = end - timedelta(days=years * 365 + 60)
    df = yf.download(symbol, start=start.strftime("%Y-%m-%d"),
                     end=end.strftime("%Y-%m-%d"), interval="1d",
                     progress=False, auto_adjust=True)
    if df.empty:
        raise ValueError(f"No OHLC data for {symbol}")
    # Flatten multi-index columns if present
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()
    logger.info(f"[features] Fetched {len(df)} bars for {symbol} "
                f"({df.index[0].date()} → {df.index[-1].date()})")
    return df


def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder RSI."""
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, 1e-9)
    return 100 - (100 / (1 + rs))


def compute_atr(high: pd.Series, low: pd.Series, close: pd.Series,
                period: int = 14) -> pd.Series:
    """Average True Range."""
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def compute_adx(high: pd.Series, low: pd.Series, close: pd.Series,
                period: int = 14) -> pd.Series:
    """Average Directional Index (simplified)."""
    plus_dm = (high - high.shift()).clip(lower=0)
    minus_dm = (low.shift() - low).clip(lower=0)
    # Zero out whichever is smaller
    plus_dm[plus_dm < minus_dm] = 0
    minus_dm[minus_dm < plus_dm] = 0

    atr = compute_atr(high, low, close, period)
    plus_di = 100 * (plus_dm.rolling(period).mean() / atr.replace(0, 1e-9))
    minus_di = 100 * (minus_dm.rolling(period).mean() / atr.replace(0, 1e-9))
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, 1e-9)
    return dx.rolling(period).mean()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute full feature set from OHLC data.
    All features use data available at market close (t) to predict t+1.
    """
    c = df["Close"]
    h = df["High"]
    lo = df["Low"]
    o = df["Open"]

    feat = pd.DataFrame(index=df.index)

    # ── Returns / Momentum ──
    feat["return_1d"] = c.pct_change()
    feat["return_2d"] = c.pct_change(2)
    feat["return_5d"] = c.pct_change(5)
    feat["return_10d"] = c.pct_change(10)
    feat["momentum_10"] = c / c.shift(10) - 1

    # ── RSI ──
    feat["rsi_14"] = compute_rsi(c, 14)
    feat["rsi_5"] = compute_rsi(c, 5)

    # ── MACD ──
    ema12 = c.ewm(span=12).mean()
    ema26 = c.ewm(span=26).mean()
    macd = ema12 - ema26
    macd_sig = macd.ewm(span=9).mean()
    feat["macd"] = macd
    feat["macd_signal"] = macd_sig
    feat["macd_hist"] = macd - macd_sig

    # ── Bollinger Bands ──
    bb_mid = c.rolling(20).mean()
    bb_std = c.rolling(20).std()
    bb_upper = bb_mid + 2 * bb_std
    bb_lower = bb_mid - 2 * bb_std
    feat["bb_width"] = (bb_upper - bb_lower) / bb_mid.replace(0, 1e-9)
    feat["bb_pctb"] = (c - bb_lower) / (bb_upper - bb_lower).replace(0, 1e-9)

    # ── ATR / Volatility ──
    feat["atr_14"] = compute_atr(h, lo, c, 14)
    feat["atr_pct"] = feat["atr_14"] / c  # normalized
    feat["realized_vol_5"] = feat["return_1d"].rolling(5).std()
    feat["realized_vol_20"] = feat["return_1d"].rolling(20).std()

    # ── Trend: SMA distances ──
    sma5 = c.rolling(5).mean()
    sma20 = c.rolling(20).mean()
    sma50 = c.rolling(50).mean()
    feat["dist_sma5"] = (c - sma5) / sma5
    feat["dist_sma20"] = (c - sma20) / sma20
    feat["dist_sma50"] = (c - sma50) / sma50
    feat["sma5_sma20_cross"] = (sma5 - sma20) / sma20

    # ── ADX (trend strength) ──
    feat["adx_14"] = compute_adx(h, lo, c, 14)

    # ── Price Action ──
    body = (c - o).abs()
    candle_range = (h - lo).replace(0, 1e-9)
    feat["body_range_ratio"] = body / candle_range
    feat["close_position"] = (c - lo) / candle_range

    # ── Calendar ──
    dow = df.index.dayofweek
    feat["dow_sin"] = np.sin(2 * np.pi * dow / 5)
    feat["dow_cos"] = np.cos(2 * np.pi * dow / 5)

    # ── Lagged features (crucial for time series) ──
    for lag in [1, 2, 3]:
        feat[f"return_lag{lag}"] = feat["return_1d"].shift(lag)
        feat[f"rsi_lag{lag}"] = feat["rsi_14"].shift(lag)

    # Rolling stats of recent returns
    feat["return_mean_5"] = feat["return_1d"].rolling(5).mean()
    feat["return_std_5"] = feat["return_1d"].rolling(5).std()

    return feat


def build_cross_asset_features(market_data_rows: list[dict]) -> dict:
    """
    Build cross-asset features from today's market data snapshot.
    Used to enrich daily prediction with macro context.
    Returns dict of feature_name → value.
    """
    data = {r["symbol"]: r for r in market_data_rows}
    feats = {}

    # VIX level and change
    if "vix" in data:
        feats["vix_level"] = data["vix"].get("value", 0)
        feats["vix_change"] = data["vix"].get("change_pct", 0)

    # DXY (dollar index)
    if "dxy" in data:
        feats["dxy_change"] = data["dxy"].get("change_pct", 0)

    # Gold (safe haven)
    if "gold" in data:
        feats["gold_change"] = data["gold"].get("change_pct", 0)

    # Oil (Japan import cost)
    if "oil_wti" in data:
        feats["oil_change"] = data["oil_wti"].get("change_pct", 0)

    # US 10Y yield
    if "us_10y" in data:
        feats["us10y_level"] = data["us_10y"].get("value", 0)
        feats["us10y_change"] = data["us_10y"].get("change_pct", 0)

    # Nikkei
    if "nikkei" in data:
        feats["nikkei_change"] = data["nikkei"].get("change_pct", 0)

    return feats


# Feature columns used for ML (order matters for model compatibility)
FEATURE_COLUMNS = [
    "return_1d", "return_2d", "return_5d", "return_10d", "momentum_10",
    "rsi_14", "rsi_5",
    "macd", "macd_signal", "macd_hist",
    "bb_width", "bb_pctb",
    "atr_pct", "realized_vol_5", "realized_vol_20",
    "dist_sma5", "dist_sma20", "dist_sma50", "sma5_sma20_cross",
    "adx_14",
    "body_range_ratio", "close_position",
    "dow_sin", "dow_cos",
    "return_lag1", "return_lag2", "return_lag3",
    "rsi_lag1", "rsi_lag2", "rsi_lag3",
    "return_mean_5", "return_std_5",
]

CROSS_ASSET_COLUMNS = [
    "vix_level", "vix_change", "dxy_change", "gold_change",
    "oil_change", "us10y_level", "us10y_change", "nikkei_change",
]
