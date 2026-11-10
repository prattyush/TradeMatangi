#!/usr/bin/env python3
"""Build backend/app/resources/index_extras.json (manual run, read-only toward brokers).

Takes the constituents of NIFTY MIDCAP 50 / AUTO / FMCG / IT / BANK / METAL / OIL & GAS
from niftyindices.com, drops every company already in nifty100.json (matched by ISIN),
and resolves the rest on ICICI Breeze (SecurityMaster, matched by ISIN) and Kite
(NSE/NFO instruments, fresh download with the token stored in DDB Local).

Options are offered only when BOTH Kite lists a stock option (lot size, strike step) and
Breeze lists an option contract for the same stock code. Nothing is guessed. Never places,
modifies or cancels an order. There is no automatic refresh: run it by hand and review the diff.

    source ~/venvs/tradematangi/bin/activate
    python scripts/update_index_extras.py [--output PATH] [--dry-run]
"""
import argparse
import collections
import csv
import io
import json
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

INDICES = {
    "NIFTY MIDCAP 50": "midcap50",
    "NIFTY AUTO": "auto",
    "NIFTY FMCG": "fmcg",
    "NIFTY IT": "it",
    "NIFTY BANK": "bank",
    "NIFTY METAL": "metal",
    "NIFTY OIL & GAS": "oilgas",
}
NSE_URL = "https://www.niftyindices.com/IndexConstituent/ind_nifty{}list.csv"
NIFTY100 = ROOT / "backend/app/resources/nifty100.json"
DEFAULT_OUTPUT = ROOT / "backend/app/resources/index_extras.json"


def download_constituents() -> list[dict]:
    rows = []
    for index_name, slug in INDICES.items():
        request = urllib.request.Request(NSE_URL.format(slug), headers={"User-Agent": "Mozilla/5.0"})
        text = urllib.request.urlopen(request, timeout=30).read().decode("utf-8-sig")
        for row in csv.DictReader(io.StringIO(text)):
            rows.append({"index": index_name, "symbol": row["Symbol"].strip(), "name": row["Company Name"].strip(),
                         "isin": row["ISIN Code"].strip()})
    return rows


def breeze_masters():
    """(ISIN -> ShortName for NSE equities, set of ShortNames with a stock option)."""
    from app.services import breeze_master
    breeze_master.ensure_security_master_downloaded("NFO")  # refreshes the daily zip
    with zipfile.ZipFile(breeze_master._master_zip_path()) as master:
        def read(name):
            return csv.DictReader(io.StringIO(master.read(name).decode("utf-8-sig")), skipinitialspace=True)
        equities = {r["ISINCode"].strip(): r["ShortName"].strip() for r in read("NSEScripMaster.txt") if r.get("Series") == "EQ"}
        options = {r["ShortName"].strip() for r in read("FONSEScripMaster.txt") if r.get("InstrumentName") == "OPTSTK"}
    return equities, options


def kite_masters():
    """(NSE tradingsymbols, {name: {lot_size, strike_interval}}) from a fresh download."""
    from app.services import kite_service
    kite = kite_service._get_kite()
    nse = {row["tradingsymbol"] for row in kite_service._kite_request(kite, "instruments", "instruments", exchange="NSE")
           if row.get("exchange") == "NSE"}
    strikes: dict[str, dict] = collections.defaultdict(lambda: collections.defaultdict(set))
    lots: dict[str, int] = {}
    for row in kite_service._kite_request(kite, "instruments", "instruments", exchange="NFO"):
        if row.get("instrument_type") != "CE":
            continue
        strikes[row["name"]][str(row["expiry"])].add(float(row["strike"]))
        lots[row["name"]] = int(row["lot_size"])
    options = {}
    for name, by_expiry in strikes.items():
        ladder = sorted(by_expiry[min(by_expiry)])  # nearest expiry
        gaps = [round(b - a, 4) for a, b in zip(ladder, ladder[1:]) if b > a]
        if gaps:
            options[name] = {"lot_size": lots[name], "strike_interval": min(gaps)}
    return nse, options


def build() -> dict:
    existing = {s["isin"] for s in json.loads(NIFTY100.read_text())["stocks"]}
    breeze_equity, breeze_options = breeze_masters()
    kite_nse, kite_options = kite_masters()
    members: dict[str, dict] = {}
    for row in download_constituents():
        if row["isin"] in existing:
            continue
        entry = members.setdefault(row["isin"], {**row, "indices": []})
        entry["indices"].append(row["index"])
    stocks, problems = [], []
    for isin, row in sorted(members.items(), key=lambda item: item[1]["symbol"]):
        symbol = row["symbol"]
        code = breeze_equity.get(isin)
        if not code or symbol not in kite_nse:
            problems.append(f"{symbol}: breeze={code} kite={symbol in kite_nse}")
            continue
        stock = {"symbol": symbol, "nse_symbol": symbol, "display_name": row["name"], "isin": isin,
                 "breeze_stock_code": code, "indices": row["indices"]}
        kite_option = kite_options.get(symbol)
        stock["option_eligible"] = bool(kite_option and code in breeze_options)
        if stock["option_eligible"]:
            stock.update(lot_size=kite_option["lot_size"], strike_interval=kite_option["strike_interval"])
        elif kite_option or code in breeze_options:
            problems.append(f"{symbol}: options listed by only one broker (kite={bool(kite_option)} breeze={code in breeze_options}); not offered")
        stocks.append(stock)
    return {"captured_on": date.today().isoformat(), "source": NSE_URL.format("<index>"),
            "indices": list(INDICES), "mapping_source": "ICICI SecurityMaster.zip + Kite instruments (NSE, NFO)",
            "stocks": stocks, "_problems": problems}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--dry-run", action="store_true", help="print the summary without writing the file")
    args = parser.parse_args()
    result = build()
    problems = result.pop("_problems")
    stocks = result["stocks"]
    print(f"{len(stocks)} stocks, {sum(s['option_eligible'] for s in stocks)} with options")
    for line in problems:
        print("NOTE", line)
    if not args.dry_run:
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print("wrote", args.output)
    return 1 if any("breeze=None" in p or "kite=False" in p for p in problems) else 0


if __name__ == "__main__":
    raise SystemExit(main())
