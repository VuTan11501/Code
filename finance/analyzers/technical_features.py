"""
Technical Features — Compute technical analysis indicators from OHLC data.
All indicators computed with pure pandas/numpy (no external TA lib needed).
Used by ml_predictor.py for training and daily prediction.
"""
import logging
import os
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

logger = logging.getLogger("jpy_forecast")

# ── FRED API (optional — macro fundamentals) ──
try:
    from fredapi import Fred
    HAS_FRED = True
except ImportError:
    HAS_FRED = False

# ── Cross-asset symbols for historical training ──
CROSS_ASSET_SYMBOLS = {
    # Volatility & risk
    "vix": "^VIX",
    # Dollar index
    "dxy": "DX-Y.NYB",
    # Safe havens
    "gold": "GC=F",
    "silver": "SI=F",
    # Energy (Japan import cost)
    "oil_wti": "CL=F",
    "natgas": "NG=F",
    # Commodities (global growth proxy)
    "copper": "HG=F",
    # US yield curve
    "us10y": "^TNX",
    "us5y": "^FVX",
    "us30y": "^TYX",
    "us2y": "^IRX",       # 3-month as proxy (2Y not always on yfinance)
    # Stock indices
    "nikkei": "^N225",
    "sp500": "^GSPC",
    "hang_seng": "^HSI",
    "dax": "^GDAXI",
    "kospi": "^KS11",
    # JPY cross pairs (direct JPY sentiment)
    "eurjpy": "EURJPY=X",
    "gbpjpy": "GBPJPY=X",
    "audjpy": "AUDJPY=X",
    # Correlated FX pairs
    "eurusd": "EURUSD=X",
    "gbpusd": "GBPUSD=X",
    "audusd": "AUDUSD=X",
    "usdcnh": "USDCNH=X",
    # Asian EM FX (correlated with JPY flows)
    "usdkrw": "USDKRW=X",
    "usdsgd": "USDSGD=X",
}


def fetch_ohlc(symbol: str = "USDJPY=X", years: int = 10) -> pd.DataFrame:
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


def fetch_cross_asset_history(years: int = 10) -> pd.DataFrame:
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

    # Build features as dict to avoid DataFrame fragmentation
    pieces = {}

    for col in cross_df.columns:
        s = cross_df[col]
        pieces[f"{col}_ret1d"] = s.pct_change()
        pieces[f"{col}_ret5d"] = s.pct_change(5)
        if col in ("vix", "us10y", "us2y", "us5y", "us30y"):
            pieces[f"{col}_level"] = s
        pieces[f"{col}_rsi14"] = compute_rsi(s, 14)
        sma20 = s.rolling(20).mean()
        pieces[f"{col}_dist_sma20"] = (s - sma20) / sma20.replace(0, 1e-9)

    # ── Yield curve features ──
    if "us10y" in cross_df.columns and "us2y" in cross_df.columns:
        pieces["yield_spread_10y_3m"] = cross_df["us10y"] - cross_df["us2y"]
        pieces["yield_spread_change"] = pieces["yield_spread_10y_3m"].diff()
    if "us10y" in cross_df.columns and "us5y" in cross_df.columns:
        pieces["yield_spread_10y_5y"] = cross_df["us10y"] - cross_df["us5y"]
    if "us30y" in cross_df.columns and "us10y" in cross_df.columns:
        pieces["yield_spread_30y_10y"] = cross_df["us30y"] - cross_df["us10y"]

    # ── VIX features ──
    if "vix" in cross_df.columns:
        pieces["vix_sma5"] = cross_df["vix"].rolling(5).mean()
        pieces["vix_above_avg"] = (cross_df["vix"] > cross_df["vix"].rolling(60).mean()).astype(float)
        pieces["vix_spike"] = (cross_df["vix"].pct_change() > 0.15).astype(float)

    # ── FX correlation features ──
    if "dxy" in cross_df.columns and "gold" in cross_df.columns:
        pieces["dxy_gold_corr_20"] = cross_df["dxy"].pct_change().rolling(20).corr(
            cross_df["gold"].pct_change())

    # ── JPY cross momentum (direct yen sentiment) ──
    for jpy_cross in ["eurjpy", "gbpjpy", "audjpy"]:
        if jpy_cross in cross_df.columns:
            pieces[f"{jpy_cross}_mom_10d"] = cross_df[jpy_cross].pct_change(10)

    # ── Asian FX cluster ──
    asian_fx = [c for c in ["usdkrw", "usdsgd"] if c in cross_df.columns]
    if len(asian_fx) >= 2:
        asian_rets = pd.DataFrame({c: cross_df[c].pct_change() for c in asian_fx})
        pieces["asian_fx_mean_ret"] = asian_rets.mean(axis=1)

    # ── Commodity cluster ──
    commodities = [c for c in ["copper", "oil_wti", "natgas"] if c in cross_df.columns]
    if commodities:
        comm_rets = pd.DataFrame({c: cross_df[c].pct_change() for c in commodities})
        pieces["commodity_mean_ret"] = comm_rets.mean(axis=1)

    # ── Global equity risk ──
    equity_indices = [c for c in ["sp500", "nikkei", "hang_seng", "dax", "kospi"]
                      if c in cross_df.columns]
    if len(equity_indices) >= 2:
        eq_rets = pd.DataFrame({c: cross_df[c].pct_change() for c in equity_indices})
        pieces["global_equity_mean_ret"] = eq_rets.mean(axis=1)
        pieces["global_equity_vol_20"] = eq_rets.mean(axis=1).rolling(20).std()

    # ── Nikkei-JPY relationship ──
    if "nikkei" in cross_df.columns:
        pieces["nikkei_vol_20"] = cross_df["nikkei"].pct_change().rolling(20).std()

    # Assemble at once (avoids fragmentation)
    feat = pd.DataFrame(pieces, index=cross_df.index)

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


# ── FRED Macro Features ──
FRED_SERIES = {
    # US-Japan rate differential (most important JPY driver)
    "us_ffr": "FEDFUNDS",          # Fed funds rate (monthly)
    "us_10y_yield": "DGS10",       # US 10Y Treasury (daily)
    "us_2y_yield": "DGS2",         # US 2Y Treasury (daily)
    "jp_rate": "IRSTCI01JPM156N",  # Japan short-term rate (monthly)
    # Inflation
    "us_cpi_yoy": "CPIAUCSL",      # US CPI (monthly, need YoY calc)
    "jp_cpi_yoy": "JPNCPIALLMINMEI",  # Japan CPI (monthly)
    # Labor market
    "us_unemployment": "UNRATE",   # US unemployment (monthly)
    # Trade
    "jp_trade_balance": "JPNXTEXVA01NCMLM",  # Japan exports (monthly)
    # Dollar strength
    "us_dxy": "DTWEXBGS",          # Trade-weighted USD broad (daily)
}


def fetch_fred_macro(years: int = 10) -> pd.DataFrame:
    """
    Fetch macro fundamentals from FRED API.
    Point-in-time: forward-fill monthly data to daily,
    lagged by 30 days for publication delay.
    """
    fred_key = os.environ.get("FRED_API_KEY", "")
    if not HAS_FRED or not fred_key:
        logger.info("[features] FRED API not available (no key or fredapi not installed)")
        return pd.DataFrame()

    fred = Fred(api_key=fred_key)
    end = datetime.now()
    start = end - timedelta(days=years * 365 + 180)

    frames = {}
    for name, series_id in FRED_SERIES.items():
        try:
            s = fred.get_series(series_id, observation_start=start, observation_end=end)
            if s is not None and len(s) > 0:
                frames[name] = s
        except Exception as e:
            logger.warning(f"[features] FRED {name} ({series_id}) failed: {e}")

    if not frames:
        return pd.DataFrame()

    combined = pd.DataFrame(frames)
    combined.index = pd.to_datetime(combined.index)
    combined = combined.sort_index()

    # CPI → YoY change
    if "us_cpi_yoy" in combined.columns:
        combined["us_cpi_yoy"] = combined["us_cpi_yoy"].pct_change(12) * 100
    if "jp_cpi_yoy" in combined.columns:
        combined["jp_cpi_yoy"] = combined["jp_cpi_yoy"].pct_change(12) * 100

    # Forward-fill to daily (monthly data is sparse)
    date_range = pd.date_range(start=combined.index[0], end=end, freq="B")
    combined = combined.reindex(date_range).ffill()

    # Publication delay: shift by 30 days (point-in-time)
    combined = combined.shift(30)

    logger.info(f"[features] FRED macro: {len(combined)} rows, "
                f"{len(combined.columns)} series: {list(combined.columns)}")
    return combined


def build_macro_features(macro_df: pd.DataFrame,
                         usdjpy_index: pd.DatetimeIndex) -> pd.DataFrame:
    """
    Build macro features from FRED data.
    All features are point-in-time safe (30-day publication lag applied).
    """
    if macro_df.empty:
        return pd.DataFrame(index=usdjpy_index)

    feat = pd.DataFrame(index=macro_df.index)

    # US-Japan rate differential (THE key driver)
    if "us_ffr" in macro_df.columns and "jp_rate" in macro_df.columns:
        feat["rate_diff_us_jp"] = macro_df["us_ffr"] - macro_df["jp_rate"]
        feat["rate_diff_change"] = feat["rate_diff_us_jp"].diff()
        feat["rate_diff_3m_change"] = feat["rate_diff_us_jp"].diff(63)

    # Yield curve (2Y-10Y spread)
    if "us_10y_yield" in macro_df.columns and "us_2y_yield" in macro_df.columns:
        feat["us_yield_curve"] = macro_df["us_10y_yield"] - macro_df["us_2y_yield"]
        feat["us_yield_curve_change"] = feat["us_yield_curve"].diff()

    # Inflation differential
    if "us_cpi_yoy" in macro_df.columns and "jp_cpi_yoy" in macro_df.columns:
        feat["inflation_diff"] = macro_df["us_cpi_yoy"] - macro_df["jp_cpi_yoy"]

    # US CPI momentum
    if "us_cpi_yoy" in macro_df.columns:
        feat["us_cpi_level"] = macro_df["us_cpi_yoy"]
        feat["us_cpi_change"] = macro_df["us_cpi_yoy"].diff()

    # Japan CPI momentum
    if "jp_cpi_yoy" in macro_df.columns:
        feat["jp_cpi_level"] = macro_df["jp_cpi_yoy"]
        feat["jp_cpi_change"] = macro_df["jp_cpi_yoy"].diff()

    # US unemployment
    if "us_unemployment" in macro_df.columns:
        feat["us_unemployment"] = macro_df["us_unemployment"]
        feat["us_unemp_change"] = macro_df["us_unemployment"].diff()

    # Japan trade balance
    if "jp_trade_balance" in macro_df.columns:
        feat["jp_trade_balance"] = macro_df["jp_trade_balance"]
        feat["jp_trade_change"] = macro_df["jp_trade_balance"].pct_change()

    # Dollar index level & momentum
    if "us_dxy" in macro_df.columns:
        feat["dxy_fred"] = macro_df["us_dxy"]
        feat["dxy_fred_ret5d"] = macro_df["us_dxy"].pct_change(5)

    # Align to USDJPY index
    feat = feat.reindex(usdjpy_index, method="ffill")

    return feat


def build_regime_features(usdjpy_df: pd.DataFrame,
                          cross_df: pd.DataFrame) -> pd.DataFrame:
    """
    Build regime/market-state features.
    Uses rolling windows of past data only (no leakage).
    """
    c = usdjpy_df["Close"]
    feat = pd.DataFrame(index=usdjpy_df.index)

    # ATR percentile (volatility regime)
    atr = compute_atr(usdjpy_df["High"], usdjpy_df["Low"], c, 14)
    feat["atr_pctile_60d"] = atr.rolling(60).apply(
        lambda x: pd.Series(x).rank(pct=True).iloc[-1], raw=False)
    feat["atr_pctile_120d"] = atr.rolling(120).apply(
        lambda x: pd.Series(x).rank(pct=True).iloc[-1], raw=False)

    # High volatility flag
    feat["high_vol_regime"] = (feat["atr_pctile_60d"] > 0.75).astype(float)

    # Trend regime: SMA50 > SMA200 (golden cross) flag
    sma50 = c.rolling(50).mean()
    sma200 = c.rolling(200).mean()
    feat["golden_cross_flag"] = (sma50 > sma200).astype(float)

    # Mean reversion z-score (20d)
    sma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    feat["zscore_20d"] = (c - sma20) / std20.replace(0, 1e-9)

    # Price acceleration (2nd derivative)
    ret = c.pct_change()
    feat["price_acceleration"] = ret.diff()

    # Rolling correlation with VIX (risk regime)
    if not cross_df.empty and "vix" in cross_df.columns:
        usdjpy_ret = c.pct_change()
        vix_aligned = cross_df["vix"].reindex(c.index, method="ffill")
        vix_ret = vix_aligned.pct_change()
        feat["usdjpy_vix_corr_20d"] = usdjpy_ret.rolling(20).corr(vix_ret)
        feat["usdjpy_vix_corr_60d"] = usdjpy_ret.rolling(60).corr(vix_ret)

    # Rolling beta to DXY
    if not cross_df.empty and "dxy" in cross_df.columns:
        usdjpy_ret = c.pct_change()
        dxy_aligned = cross_df["dxy"].reindex(c.index, method="ffill")
        dxy_ret = dxy_aligned.pct_change()
        # 20d rolling beta
        cov_20 = usdjpy_ret.rolling(20).cov(dxy_ret)
        var_20 = dxy_ret.rolling(20).var()
        feat["usdjpy_dxy_beta_20d"] = cov_20 / var_20.replace(0, 1e-9)

    # Month/quarter seasonality (sin/cos)
    month = usdjpy_df.index.month
    feat["month_sin"] = np.sin(2 * np.pi * month / 12)
    feat["month_cos"] = np.cos(2 * np.pi * month / 12)
    feat["is_month_end"] = usdjpy_df.index.is_month_end.astype(float)
    feat["is_quarter_end"] = usdjpy_df.index.is_quarter_end.astype(float)
    # Japan fiscal year end (March)
    feat["jp_fiscal_yearend"] = (month == 3).astype(float)

    # Lag all by 1 day for safety
    feat = feat.shift(1)

    return feat
