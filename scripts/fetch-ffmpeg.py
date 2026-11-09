#!/usr/bin/env python3
"""Fetch the pinned FFmpeg build that the desktop installer bundles (Trading Video Maker).

    python scripts/fetch-ffmpeg.py            # download, verify, install into windowsapp/src-tauri/binaries
    python scripts/fetch-ffmpeg.py --zip F    # use an already downloaded zip (still verified)

The Windows build is the "essentials" GPL build published by Gyan Doshi (https://www.gyan.dev/ffmpeg/builds/,
mirrored at https://github.com/GyanD/codexffmpeg/releases). It includes libx264 and the hardware H.264
encoders. The file is checked against a pinned SHA-256 before it is used, and is never committed to git
(`src-tauri/binaries/` is ignored). To update: change VERSION and SHA256 together after checking the
checksum against the publisher's page.
"""
import argparse
import hashlib
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

VERSION = "9.0.2"
URL = f"https://github.com/GyanD/codexffmpeg/releases/download/{VERSION}/ffmpeg-{VERSION}-essentials_build.zip"
SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
TRIPLE = "x86_64-pc-windows-msvc"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "windowsapp" / "src-tauri" / "binaries"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path, attempts: int = 5) -> None:
    """GitHub release downloads sometimes answer 5xx for a moment (a 504 failed a CI build), so retry."""
    for attempt in range(1, attempts + 1):
        try:
            urllib.request.urlretrieve(url, target)
            return
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            # A 4xx is a real problem (wrong URL); only server errors and network drops are retried.
            if isinstance(error, urllib.error.HTTPError) and error.code < 500:
                raise
            if attempt == attempts:
                raise
            wait = 5 * attempt
            print(f"Download failed ({error}); retrying in {wait}s ({attempt}/{attempts})", file=sys.stderr)
            time.sleep(wait)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", type=Path, help="use this already downloaded zip instead of downloading")
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="output folder")
    args = parser.parse_args()

    archive = args.zip
    downloaded = False
    if archive is None:
        archive = args.out / f"ffmpeg-{VERSION}.zip.part"
        args.out.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {URL}")
        download(URL, archive)
        downloaded = True

    try:
        actual = sha256_of(archive)
        if actual != SHA256:
            print(f"SHA-256 mismatch for {archive}\n  expected {SHA256}\n  actual   {actual}", file=sys.stderr)
            return 1
        args.out.mkdir(parents=True, exist_ok=True)
        exe_target = args.out / f"ffmpeg-{TRIPLE}.exe"
        license_target = args.out / "FFMPEG-LICENSE.txt"
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
            exe = next((n for n in names if n.endswith("/bin/ffmpeg.exe")), None)
            lic = next((n for n in names if n.endswith("/LICENSE")), None)
            if exe is None or lic is None:
                print("The archive does not contain bin/ffmpeg.exe and LICENSE.", file=sys.stderr)
                return 1
            with bundle.open(exe) as src, exe_target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            with bundle.open(lic) as src, license_target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
        print(f"Installed {exe_target} ({exe_target.stat().st_size // (1 << 20)} MB) and {license_target.name}")
        return 0
    finally:
        if downloaded and archive.exists():
            archive.unlink()


if __name__ == "__main__":
    sys.exit(main())
