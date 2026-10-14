#!/usr/bin/env python3
"""
Options Indicator Analysis Script
==================================
Loads 1-second underlying + CE + PE parquet data, resamples to 1-minute candles
starting from a user-specified anchor time, and plots:

  Panel 0  — Underlying (equity/index) candlesticks
  Panel 1  — CE candlesticks
  Panel 2  — CE indicators:
               • CE% / PE%   (CE bar % chg relative to CE bar open / PE bar % chg relative to PE bar open)
               • Und% / CE%  (Underlying bar % chg / CE bar % chg)
  Panel 3  — PE candlesticks
  Panel 4  — PE indicators:
               • PE% / CE%
               • Und% / PE%

Usage
-----
  python scripts/options_indicator.py \\
      --date 2026-05-22 \\
      --symbol NIFTY \\
      --otm 2 \\
      --time 09:30

Parameters
----------
  --date    Trading date in YYYY-MM-DD format
  --symbol  Symbol key (NIFTY, BSESEN, RELIND, TATMOT, TATPOW)
  --otm     OTM offset — number of strikes above ATM for CE (PE mirrored below)
             0 = ATM (default)
  --time    Anchor time in HH:MM — used both to compute ATM from the underlying
             price at that moment, and as the start of the plotted data range
  --save    Optional path to save the plot (e.g. out.png); skips interactive show

Dependencies (install if missing):
  pip install mplfinance matplotlib numpy pandas pyarrow
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow importing from the backend without installing it as a package
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import matplotlib.patches as mpatches

try:
    import mplfinance as mpf
except ImportError:
    print("ERROR: mplfinance not found. Install it with: pip install mplfinance")
    sys.exit(1)

from app.config import OHLCDATA_DIR
from app.services.data_loader import load_dataframe
from app.services.options_service import (
    get_expiry_date,
    load_options_dataframe,
    fetch_options_historical,
    options_parquet_path,
    STRIKE_INTERVALS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resample_1min(df: pd.DataFrame, from_ts: pd.Timestamp) -> pd.DataFrame:
    """Filter to from_ts and resample second-level OHLC to 1-minute candles."""
    filtered = df[df.index >= from_ts]
    candles = (
        filtered.resample("1min")
        .agg(open=("open", "first"), high=("high", "max"),
             low=("low", "min"),   close=("close", "last"))
        .dropna()
    )
    return candles


def _load_or_fetch_options(
    symbol: str, date: str, strike: int, expiry: str, right: str
) -> pd.DataFrame:
    """Return 1-second options DataFrame — from cache if available, else Breeze fetch."""
    pq = options_parquet_path(symbol, date, strike, expiry, right)
    if pq.exists():
        print(f"    Cache hit  : {pq.name}")
        return load_options_dataframe(symbol, date, strike, expiry, right)
    print(f"    Fetching   : {symbol} {right} strike={strike} expiry={expiry} date={date}")
    fetch_options_historical(symbol, date, strike, expiry, right)
    return load_options_dataframe(symbol, date, strike, expiry, right)


def _safe_ratio(num: pd.Series, den: pd.Series, clip: float = 10.0) -> pd.Series:
    """Element-wise num/den with NaN for zero/near-zero denominator, clipped to ±clip."""
    with np.errstate(divide="ignore", invalid="ignore"):
        result = np.where(den.abs() > 1e-8, num / den, np.nan)
    return pd.Series(result, index=num.index).clip(-clip, clip)


def _bar_pct(df: pd.DataFrame) -> pd.Series:
    """% change of each bar's close vs its own open. NaN when open == 0."""
    return (df["close"] - df["open"]) / df["open"].replace(0, np.nan) * 100


# ---------------------------------------------------------------------------
# Candlestick drawing (manual) — guarantees integer x-axis across all panels
# ---------------------------------------------------------------------------

_UP_COLOR   = "#26A69A"   # teal  — bullish candle
_DOWN_COLOR = "#EF5350"   # red   — bearish candle


def _draw_candles(ax: plt.Axes, df: pd.DataFrame, title: str = "") -> None:
    """Draw OHLC candlesticks on *ax* using integer x positions 0…N-1."""
    n = len(df)
    for i, (_, row) in enumerate(df.iterrows()):
        is_up = row["close"] >= row["open"]
        color = _UP_COLOR if is_up else _DOWN_COLOR

        # High-low wick
        ax.plot([i, i], [row["low"], row["high"]], color=color, linewidth=0.7, zorder=2)

        # Body
        body_lo = min(row["open"], row["close"])
        body_hi = max(row["open"], row["close"])
        body_h  = body_hi - body_lo
        if body_h < 1e-6:   # doji — draw a horizontal line
            ax.plot([i - 0.3, i + 0.3], [row["close"], row["close"]],
                    color=color, linewidth=0.8, zorder=3)
        else:
            rect = mpatches.FancyBboxPatch(
                (i - 0.4, body_lo), 0.8, body_h,
                boxstyle="square,pad=0",
                facecolor=color, edgecolor=color, linewidth=0.2, zorder=3,
            )
            ax.add_patch(rect)

    ax.set_xlim(-0.5, n - 0.5)
    ax.autoscale_view(scalex=False)
    ax.set_title(title, fontsize=10, loc="left", pad=3)
    ax.yaxis.set_tick_params(labelsize=7)
    ax.grid(True, alpha=0.25, linewidth=0.4)


def _label_xaxis(ax: plt.Axes, index: pd.DatetimeIndex, n_ticks: int = 12) -> None:
    """Apply HH:MM time labels at evenly spaced integer positions."""
    n = len(index)
    step = max(1, n // n_ticks)
    positions = list(range(0, n, step))
    labels = [index[i].strftime("%H:%M") for i in positions]
    ax.set_xticks(positions)
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=7)


def _draw_indicator(
    ax: plt.Axes,
    series: pd.Series,
    label: str,
    color: str,
    title: str = "",
) -> None:
    """Plot a single ratio indicator line on *ax* with zero/±1 reference grid."""
    n = len(series)
    x = np.arange(n)

    ax.plot(x, series.values, label=label, color=color, linewidth=1.2)

    ax.axhline(0,  color="white",   linestyle="--", linewidth=0.7, alpha=0.5)
    ax.axhline(1,  color="#4CAF50", linestyle=":",  linewidth=0.7, alpha=0.5)
    ax.axhline(-1, color="#FF7043", linestyle=":",  linewidth=0.7, alpha=0.5)

    ax.set_xlim(-0.5, n - 0.5)
    ax.set_ylabel("Ratio", fontsize=8)
    ax.set_title(title, fontsize=9, loc="left", pad=2)
    ax.legend(fontsize=7, loc="upper left", framealpha=0.5)
    ax.yaxis.set_tick_params(labelsize=7)
    ax.grid(True, alpha=0.25, linewidth=0.4)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Options indicator chart")
    parser.add_argument("--date",   required=True, help="Trading date YYYY-MM-DD")
    parser.add_argument("--symbol", required=True, help="Symbol e.g. NIFTY")
    parser.add_argument("--otm",    type=int, default=0,
                        help="OTM offset in strike count above ATM for CE (default 0 = ATM)")
    parser.add_argument("--time",   required=True,
                        help="Anchor time HH:MM — ATM computed at this price, data starts here")
    parser.add_argument("--save",   default=None,
                        help="Save plot to this path instead of showing interactively")
    args = parser.parse_args()

    date   = args.date
    symbol = args.symbol.upper()
    otm    = args.otm
    t      = args.time.strip()
    if len(t) == 5:   # HH:MM → HH:MM:SS
        t += ":00"
    start_time = t

    interval   = STRIKE_INTERVALS.get(symbol, 5)
    start_ts   = pd.Timestamp(f"{date} {start_time}", tz="UTC")

    print(f"\n{'='*62}")
    print(f"  Options Indicator")
    print(f"  Symbol : {symbol}   Date : {date}")
    print(f"  OTM    : {otm}      Start: {start_time}")
    print(f"{'='*62}")

    # ------------------------------------------------------------------
    # 1. Load underlying
    # ------------------------------------------------------------------
    print("\n[1/3] Underlying data …")
    try:
        und_raw = load_dataframe(symbol, date)
    except FileNotFoundError as exc:
        print(f"  ERROR: {exc}")
        sys.exit(1)

    after_start = und_raw[und_raw.index >= start_ts]
    if after_start.empty:
        print(f"  ERROR: No underlying data at or after {start_time}")
        sys.exit(1)

    anchor_price = float(after_start.iloc[0]["close"])
    atm          = int(round(anchor_price / interval) * interval)
    ce_strike    = atm + otm * interval
    pe_strike    = atm - otm * interval
    expiry       = get_expiry_date(symbol, date)

    print(f"  Anchor price @ {start_time}: {anchor_price:.2f}")
    print(f"  ATM={atm}  CE strike={ce_strike}  PE strike={pe_strike}  Expiry={expiry}")

    # ------------------------------------------------------------------
    # 2. Load CE / PE options
    # ------------------------------------------------------------------
    print(f"\n[2/3] Options data …")
    print(f"  CE ({ce_strike})")
    try:
        ce_raw = _load_or_fetch_options(symbol, date, ce_strike, expiry, "CE")
    except Exception as exc:
        print(f"  ERROR loading CE: {exc}")
        sys.exit(1)

    print(f"  PE ({pe_strike})")
    try:
        pe_raw = _load_or_fetch_options(symbol, date, pe_strike, expiry, "PE")
    except Exception as exc:
        print(f"  ERROR loading PE: {exc}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 3. Resample to 1-min and align
    # ------------------------------------------------------------------
    und_1m = _resample_1min(und_raw, start_ts)
    ce_1m  = _resample_1min(ce_raw,  start_ts)
    pe_1m  = _resample_1min(pe_raw,  start_ts)

    common_idx = und_1m.index.intersection(ce_1m.index).intersection(pe_1m.index)
    if common_idx.empty:
        print("ERROR: No overlapping 1-minute bars across underlying, CE, and PE")
        sys.exit(1)

    und = und_1m.loc[common_idx]
    ce  = ce_1m.loc[common_idx]
    pe  = pe_1m.loc[common_idx]

    n_bars = len(common_idx)
    print(f"\n[3/3] Computing indicators ({n_bars} 1-min bars) …")

    # % change: each bar's close vs its own open
    ce_pct  = _bar_pct(ce)
    pe_pct  = _bar_pct(pe)
    und_pct = _bar_pct(und)

    ind_ce_pe  = _safe_ratio(ce_pct,  pe_pct)   # CE%  / PE%
    ind_pe_ce  = _safe_ratio(pe_pct,  ce_pct)   # PE%  / CE%
    ind_und_ce = _safe_ratio(und_pct, ce_pct)   # Und% / CE%
    ind_und_pe = _safe_ratio(und_pct, pe_pct)   # Und% / PE%

    # ------------------------------------------------------------------
    # 4. Plot — 7 panels: 3 candle charts + 4 individual indicator panels
    # ------------------------------------------------------------------
    print("\nPlotting …")

    plt.style.use("dark_background")
    fig = plt.figure(figsize=(19, 28))
    fig.patch.set_facecolor("#131722")
    fig.suptitle(
        f"{symbol}  |  {date}  |  OTM:{otm}  "
        f"|  CE {ce_strike}  /  PE {pe_strike}  |  Expiry: {expiry}",
        fontsize=13, fontweight="bold", color="white", y=0.988,
    )

    # Rows: und(2.5), ce(2), pe(2), ind×4(1 each)
    gs = gridspec.GridSpec(
        7, 1,
        height_ratios=[2.5, 2, 2, 1, 1, 1, 1],
        hspace=0.55,
        figure=fig,
    )
    ax_und      = fig.add_subplot(gs[0])
    ax_ce       = fig.add_subplot(gs[1])
    ax_pe       = fig.add_subplot(gs[2])
    ax_ind_cepe = fig.add_subplot(gs[3])
    ax_ind_pece = fig.add_subplot(gs[4])
    ax_ind_uce  = fig.add_subplot(gs[5])
    ax_ind_upe  = fig.add_subplot(gs[6])

    all_axes = (ax_und, ax_ce, ax_pe,
                ax_ind_cepe, ax_ind_pece, ax_ind_uce, ax_ind_upe)
    for ax in all_axes:
        ax.set_facecolor("#131722")
        for spine in ax.spines.values():
            spine.set_edgecolor("#2A2E39")

    # --- Candle charts ---
    _draw_candles(ax_und, und, title=f"Underlying: {symbol}")
    _label_xaxis(ax_und, common_idx)

    _draw_candles(ax_ce, ce, title=f"CE  {ce_strike}")
    _label_xaxis(ax_ce, common_idx)

    _draw_candles(ax_pe, pe, title=f"PE  {pe_strike}")
    _label_xaxis(ax_pe, common_idx)

    # --- 4 individual indicator panels ---
    _draw_indicator(ax_ind_cepe, ind_ce_pe,  "CE% / PE%",   "#42A5F5", title="CE% / PE%")
    _label_xaxis(ax_ind_cepe, common_idx)

    _draw_indicator(ax_ind_pece, ind_pe_ce,  "PE% / CE%",   "#AB47BC", title="PE% / CE%")
    _label_xaxis(ax_ind_pece, common_idx)

    _draw_indicator(ax_ind_uce,  ind_und_ce * 10, "(Und%/CE%) ×10",  "#FFA726", title="(Und%/CE%) ×10")
    _label_xaxis(ax_ind_uce, common_idx)

    _draw_indicator(ax_ind_upe,  ind_und_pe * 10, "(Und%/PE%) ×10",  "#EF5350", title="(Und%/PE%) ×10")
    _label_xaxis(ax_ind_upe, common_idx)

    plt.tight_layout(rect=[0, 0, 1, 0.985])

    if args.save:
        fig.savefig(args.save, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
        print(f"  Saved to: {args.save}")
    else:
        plt.show()

    print("Done.")


if __name__ == "__main__":
    main()
