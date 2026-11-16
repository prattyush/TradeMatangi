#!/usr/bin/env python3
"""Build the index of cached second-level days that the Games list (GET /api/desktop/v1/games/availability).

Run it by hand after the data cache is refreshed. It only reads the OHLC cache directory; it never downloads
data and never calls a broker. It is incremental: files whose size and modification time are unchanged are not
read again, so a re-run takes seconds. The file is replaced atomically, and the backend picks it up on the next request.

    python scripts/build-games-index.py                # write the index at GAMES_INDEX_PATH (default data/games-index.json)
    python scripts/build-games-index.py --full         # ignore the previous index and read every file
    python scripts/build-games-index.py --dry-run      # scan and print, write nothing
"""
import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app import config
from app.services import games_index


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", type=Path, default=None, help="OHLC cache directory (default: the backend's OHLCDATA_DIR)")
    parser.add_argument("--output", type=Path, default=None, help="index file (default: GAMES_INDEX_PATH)")
    parser.add_argument("--full", action="store_true", help="read every file again")
    parser.add_argument("--dry-run", action="store_true", help="do not write the index")
    args = parser.parse_args()

    directory = args.data_dir or games_index.ohlc_dir()
    output = args.output or Path(config.GAMES_INDEX_PATH)
    if not directory.is_dir():
        print(f"OHLC directory not found: {directory}", file=sys.stderr)
        return 2
    previous = None if args.full else games_index.read_index_file(output)
    started = time.monotonic()
    document, stats = games_index.build_index(directory, previous)
    elapsed = time.monotonic() - started

    print(f"Scanned {directory}")
    print(f"  day files {stats.day_files}, option files {stats.option_files}; read {stats.read}, reused {stats.reused}; {elapsed:.1f}s")
    for symbol, entry in document["symbols"].items():
        contracts = sum(len(side) for by_expiry in entry["options"].values() for sides in by_expiry.values() for side in sides.values())
        print(f"  {symbol}: {len(entry['dates'])} days ({entry['dates'][0] if entry['dates'] else '-'} .. {entry['dates'][-1] if entry['dates'] else '-'}), "
              f"{len(entry['options'])} days with options, {contracts} contracts")
    for message in stats.errors:
        print(f"  skipped: {message}", file=sys.stderr)
    if args.dry_run:
        print("Dry run: nothing written.")
        return 1 if stats.errors else 0
    games_index.write_index(document, output)
    print(f"Wrote {output} ({output.stat().st_size / 1024:.0f} KB)")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
