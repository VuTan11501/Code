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

# ── Cross-asset symbols for historical training ──
CROSS_ASSET_SYMBOLS = {
    # Volatility & risk
    "vix": "^VIX",
    # Dollar index
    "dxy": "DX-Y.NYB",
    # Safe havens
    "gold": "GC=F",
    # Energy (Japan import cost)
    "oil_wti": "CL=F",
    # US yields
    "us10y": "^TNX",
    "us2y": "^IRX",       # 3-month as proxy (2Y not always on yfinance)
    # Stock indices
    "nikkei": "^N225",
    "sp500": "^GSPC",
    # Correlated FX pairs
    "eurusd": "EURUSD=X",
    "gbpusd": "GBPUSD=X",
    "audusd": "AUDUSD=X",
    "usdcnh": "USDCNH=X",  # CNH = offshore yuan
}


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


def fetch_cross_asset_history(years: int = 5) -> pd.DataFrame:
    """
    Fetch historical close prices for all cross-asset symbols.
    Returns DataFrame with date index, columns = symbol keys.
    All lagged by 1 day to avoid timing leakage.
    """
    end = datetime.now()
    start = end - timedelta(days=years * 365 + 60)
    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    frames = {}
    for name, ticker in CROSS_ASSET_SYMBOLS.items():
        try:
            raw = yf.download(ticker, start=start_str, end=end_str,
                              interval="1d", progress=False, auto_adjust=True)
            if raw.empty:
                continue
            if isinstance(raw.columns, pd.MultiIndex):
                raw.columns = raw.columns.get_level_values(0)
            frames[name] = raw["Close"]
        except Exception as e:
            logger.warning(f"[features] Failed to fetch {name} ({ticker}): {e}")

    if not frames:
        return pd.DataFrame()

    combined = pd.DataFrame(frames)
    combined.index = pd.to_datetime(combined.index)
    combined = combined.sort_index()
    # Forward-fill gaps (holidays differ across markets)
    combined = combined.ffill()

    logger.info(f"[features] Cross-asset: {len(combined)} rows, "
                f"{len(combined.columns)} assets: {list(combined.columns)}")
    return combined


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

    # ── Extended momentum / mean reversion ──
    feat["return_20d"] = c.pct_change(20)
    feat["rsi_21"] = compute_rsi(c, 21)
    feat["roc_5"] = (c / c.shift(5) - 1) * 100    # Rate of Change
    feat["roc_20"] = (c / c.shift(20) - 1) * 100

    # ── Stochastic Oscillator ──
    low14 = lo.rolling(14).min()
    high14 = h.rolling(14).max()
    feat["stoch_k"] = 100 * (c - low14) / (high14 - low14).replace(0, 1e-9)
    feat["stoch_d"] = feat["stoch_k"].rolling(3).mean()

    # ── Williams %R ──
    feat["williams_r"] = -100 * (high14 - c) / (high14 - low14).replace(0, 1e-9)

    # ── CCI (Commodity Channel Index) ──
    tp = (h + lo + c) / 3
    tp_sma = tp.rolling(20).mean()
    tp_mad = tp.rolling(20).apply(lambda x: np.mean(np.abs(x - x.mean())), raw=True)
    feat["cci_20"] = (tp - tp_sma) / (0.015 * tp_mad).replace(0, 1e-9)

    # ── OBV trend (volume-based, normalized) ──
    if "Volume" in df.columns and df["Volume"].sum() > 0:
        obv = (np.sign(c.diff()) * df["Volume"]).fillna(0).cumsum()
        feat["obv_slope_5"] = obv.rolling(5).apply(
            lambda x: np.polyfit(range(len(x)), x, 1)[0] if len(x) == 5 else 0, raw=True
        ) / c  # normalize by price

    # ── Volatility extras ──
    feat["realized_vol_10"] = feat["return_1d"].rolling(10).std()
    feat["vol_ratio_5_20"] = feat["realized_vol_5"] / feat["realized_vol_20"].replace(0, 1e-9)
    feat["high_low_pct"] = (h - lo) / c  # daily range as % of close

    # ── SMA 100, 200 ──
    sma100 = c.rolling(100).mean()
    sma200 = c.rolling(200).mean()
    feat["dist_sma100"] = (c - sma100) / sma100
    feat["dist_sma200"] = (c - sma200) / sma200
    feat["sma50_sma200_cross"] = (sma50 - sma200) / sma200  # golden/death cross

    # ── Extended lags ──
    for lag in [5, 10]:
        feat[f"return_lag{lag}"] = feat["return_1d"].shift(lag)

    # Rolling skewness & kurtosis of returns
    feat["return_skew_20"] = feat["return_1d"].rolling(20).skew()
    feat["return_kurt_20"] = feat["return_1d"].rolling(20).kurt()

    return feat


def build_cross_asset_indicators(cross_df: pd.DataFrame, usdjpy_index: pd.DatetimeIndex) -> pd.DataFrame:
    """
    Compute cross-asset features from historical data.
    ALL features lagged by 1 day to prevent timing leakage.
    Returns DataFrame aligned to usdjpy_index.
    """
    if cross_df.empty:
        return pd.DataFrame(index=usdjpy_index)

    feat = pd.DataFrame(index=cross_df.index)

    for col in cross_df.columns:
        s = cross_df[col]
        # Daily return (lagged 1 day)
        feat[f"{col}_ret1d"] = s.pct_change()
        # 5-day return
        feat[f"{col}_ret5d"] = s.pct_change(5)
        # Level (for VIX, yields)
        if col in ("vix", "us10y", "us2y"):
            feat[f"{col}_level"] = s
        # RSI
        feat[f"{col}_rsi14"] = compute_rsi(s, 14)
        # Distance from 20-day SMA
        sma20 = s.rolling(20).mean()
        feat[f"{col}_dist_sma20"] = (s - sma20) / sma20.replace(0, 1e-9)

    # ── Yield spread (US10Y - short rate proxy) ──
    if "us10y" in cross_df.columns and "us2y" in cross_df.columns:
        feat["yield_spread_10y_3m"] = cross_df["us10y"] - cross_df["us2y"]
        feat["yield_spread_change"] = feat["yield_spread_10y_3m"].diff()

    # ── VIX term structure proxy ──
    if "vix" in cross_df.columns:
        feat["vix_sma5"] = cross_df["vix"].rolling(5).mean()
        feat["vix_above_avg"] = (cross_df["vix"] > cross_df["vix"].rolling(60).mean()).astype(float)

    # ── FX correlation features ──
    if "eurusd" in cross_df.columns:
        feat["eurusd_ret1d"] = cross_df["eurusd"].pct_change()
    if "dxy" in cross_df.columns and "gold" in cross_df.columns:
        # DXY-Gold inverse: when both move same direction, unusual
        feat["dxy_gold_corr_20"] = cross_df["dxy"].pct_change().rolling(20).corr(
            cross_df["gold"].pct_change())

    # ── Nikkei-JPY relationship ──
    if "nikkei" in cross_df.columns:
        feat["nikkei_vol_20"] = cross_df["nikkei"].pct_change().rolling(20).std()

    # LAG everything by 1 day to prevent timing leakage
    feat = feat.shift(1)

    # Align to USDJPY index
    feat = feat.reindex(usdjpy_index, method="ffill")

    return feat


# Feature columns used for ML (order matters for model compatibility)
FEATURE_COLUMNS = [
    # ── USDJPY technical (32 original) ──
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
    # ── Extended USDJPY features (new) ──
    "return_20d", "rsi_21", "roc_5", "roc_20",
    "stoch_k", "stoch_d", "williams_r", "cci_20",
    "realized_vol_10", "vol_ratio_5_20", "high_low_pct",
    "dist_sma100",
    "return_lag5", "return_lag10",
    "return_skew_20", "return_kurt_20",
]

# Cross-asset feature columns (auto-discovered during training)
# These are generated dynamically by build_cross_asset_indicators()
CROSS_ASSET_COLUMNS = []  # populated at runtime
