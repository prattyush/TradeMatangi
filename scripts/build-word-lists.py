#!/usr/bin/env python3
"""Build the Word games' lists (Phase 25, B5) into shared/games/brain/assets/words/.

    python3 scripts/build-word-lists.py --enable enable1.txt --scowl scowl-2020.12.07/ [--out DIR]

Inputs (download them yourself, check the SHA-256 values printed below; nothing is fetched here):
  ENABLE   enable1.txt  https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt
           sha256 3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89
  SCOWL    scowl-2020.12.07.tar.gz, extracted  https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz
           sha256 5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc

Outputs (all deterministic):
  valid.fc.txt    every ENABLE word minus the excluded ones, a-z only, sorted, front-coded      (accepts player input, Letter Grid dictionary)
  common.fc.txt   SCOWL levels <= 60 (english + american words, lowercase a-z only) inside ENABLE, length 3-9, not excluded,
                  front-coded, one tier digit at the end of each line: 1 = SCOWL level <= 35, 2 = 40-50, 3 = 55-60
  exclude.txt     the words removed from ENABLE as offensive (so the exclusion can be reviewed and tested)
  NOTICE          licences and credits, SCOWL's `Copyright` verbatim, the filtering applied, SHA-256 of every source and output

Front coding: each line is one character for the length of the prefix shared with the previous word (0-9 then a-z = 0..35),
followed by the rest of the word (common.fc.txt adds the tier digit last). Decoded by `shared/games/brain/words/wordlist.ts`.

Exclusion = SCOWL's own taboo lists (misc/offensive.1, offensive.2, profane.1, profane.3) with their inflections, plus every
word containing one of the strong stems below. Extend STRONG_STEMS / EXTRA_WORDS and rerun to exclude more.
"""
import argparse
import hashlib
import re
from pathlib import Path

OUT_DEFAULT = Path(__file__).resolve().parent.parent / "shared/games/brain/assets/words"
LEVELS = [10, 20, 35, 40, 50, 55, 60]
COMMON_LENGTHS = (3, 9)
SUFFIXES = ["", "s", "es", "ed", "d", "ing", "er", "ers", "y", "ier", "iest", "ly", "ness"]
# Words containing any of these are excluded outright (authored here, not copied from a share-alike list).
STRONG_STEMS = ["fuck", "shit", "cunt", "nigg", "cocksuck", "whore", "slut", "bitch", "twat", "wank"]
EXTRA_WORDS: list[str] = []
SOURCES_NOTE = {
    "enable": "ENABLE word list (enable1.txt, mirror dolph/dictionary)",
    "scowl": "SCOWL 2020.12.07 (Spell Checker Oriented Word Lists)",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_words(path: Path) -> list[str]:
    return path.read_text(encoding="latin-1").split("\n")


def front_code(words: list[str], suffix=lambda i: "") -> str:
    out, previous = [], ""
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    for i, word in enumerate(words):
        n = 0
        while n < min(len(word), len(previous)) and word[n] == previous[n]:
            n += 1
        assert n < len(alphabet)
        out.append(alphabet[n] + word[n:] + suffix(i))
        previous = word
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--enable", required=True, type=Path)
    parser.add_argument("--scowl", required=True, type=Path, help="the extracted scowl-2020.12.07 directory")
    parser.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = parser.parse_args()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    enable = sorted({w for w in read_words(args.enable) if re.fullmatch(r"[a-z]+", w)})
    enable_set = set(enable)

    # ---- exclusion ---------------------------------------------------------------------------------------------------
    bases = set(EXTRA_WORDS)
    for name in ["offensive.1", "offensive.2", "profane.1", "profane.3"]:
        for line in read_words(args.scowl / "misc" / name):
            word = line.split("'")[0].strip().lower()
            if re.fullmatch(r"[a-z]+", word):
                bases.add(word)
    excluded = set()
    for word in enable:
        if any(stem in word for stem in STRONG_STEMS):
            excluded.add(word)
            continue
        for base in bases:
            if word.startswith(base) and word[len(base):] in SUFFIXES:
                excluded.add(word)
                break
    valid = [w for w in enable if w not in excluded]

    # ---- common (tiered) -----------------------------------------------------------------------------------------------
    tier_of_level = lambda level: 1 if level <= 35 else 2 if level <= 50 else 3
    best: dict[str, int] = {}
    for level in LEVELS:
        for prefix in ["english-words", "american-words"]:
            path = args.scowl / "final" / f"{prefix}.{level}"
            if not path.exists():
                continue
            for word in read_words(path):
                if re.fullmatch(r"[a-z]+", word) and COMMON_LENGTHS[0] <= len(word) <= COMMON_LENGTHS[1] and word in enable_set and word not in excluded:
                    tier = tier_of_level(level)
                    best[word] = min(best.get(word, 9), tier)
    common = sorted(best)

    # ---- write ----------------------------------------------------------------------------------------------------------
    (out / "valid.fc.txt").write_text(front_code(valid), encoding="ascii")
    (out / "common.fc.txt").write_text(front_code(common, lambda i: str(best[common[i]])), encoding="ascii")
    (out / "exclude.txt").write_text("\n".join(sorted(excluded)) + "\n", encoding="ascii")

    copyright_text = (args.scowl / "Copyright").read_text(encoding="latin-1")
    tiers = {t: sum(1 for w in common if best[w] == t) for t in (1, 2, 3)}
    shipped = {name: sha256(out / name) for name in ["valid.fc.txt", "common.fc.txt", "exclude.txt"]}
    notice = f"""NOTICE: word lists used by the Trade Matangi Games (Brain: Anagram Dash, Letter Grid, Word Ladder)
================================================================================================

The files valid.fc.txt, common.fc.txt and exclude.txt in this directory are FILTERED AND RE-FORMATTED DERIVATIVES (modified
versions) of the ENABLE word list and of SCOWL word lists. They are not the original files. Built by scripts/build-word-lists.py.

1. ENABLE word list. Public domain. Released by M. Cooper ("thegrendel") with the efforts of Alan Beale. Credit is given here to
   the originators of the list. The ENABLE word files are not restricted from redistribution (the release text is part of SCOWL's
   Copyright file reproduced below).
   Source: {SOURCES_NOTE['enable']}  SHA-256 {sha256(args.enable)}  ({len(enable)} a-z words)

2. SCOWL (Spell Checker Oriented Word Lists) 2020.12.07, Copyright 2000-2018 by Kevin Atkinson. The collective work is under the
   permission notice in SCOWL's Copyright file, reproduced in full and unchanged in the appendix below, together with the notices
   of the components SCOWL names: Moby Words II (Grady Ward), Brian Kelk's UK English wordlist, the 12Dicts package and
   supplement (Alan Beale), WordNet 1.6 (Princeton University: used in SCOWL's inflection data), VarCon (Kevin Atkinson, Benjamin
   Titze) and the Ispell-derived American spellings (Geoff Kuenning). Only SCOWL levels 10 to 60 (english-words and american-words)
   are used. The levels above 60 (which bring the UKACD notice and more) are NOT used.
   Source: {SOURCES_NOTE['scowl']}  SHA-256 of scowl-2020.12.07.tar.gz 5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc

3. What was done to them (a modification notice, as the Ispell licence in the appendix requires):
   - valid.fc.txt: every ENABLE word (letters a-z only) except the excluded words, sorted, front-coded. {len(valid)} words.
   - common.fc.txt: words of SCOWL levels <= 60 (english-words and american-words, lowercase a-z only, so no proper nouns) that are
     also in ENABLE, of 3 to 9 letters, not excluded, sorted, front-coded, with a tier digit last (1 = level <= 35, 2 = 40-50,
     3 = 55-60). {len(common)} words: tier 1 = {tiers[1]}, tier 2 = {tiers[2]}, tier 3 = {tiers[3]}.
   - exclude.txt: the {len(excluded)} words removed as offensive. They are SCOWL's own taboo lists (misc/offensive.1, offensive.2,
     profane.1, profane.3) with common inflections, plus every ENABLE word containing one of these stems chosen by us: {", ".join(STRONG_STEMS)}.
   - Front coding: one character (0-9, a-z) for the shared prefix length with the previous word, then the rest of the word.

4. SHA-256 of the shipped files (checked by the tests):
   valid.fc.txt   {shipped['valid.fc.txt']}
   common.fc.txt  {shipped['common.fc.txt']}
   exclude.txt    {shipped['exclude.txt']}

APPENDIX: SCOWL's Copyright file, verbatim (scowl-2020.12.07/Copyright)
------------------------------------------------------------------------------------------------

{copyright_text}"""
    (out / "NOTICE").write_text(notice, encoding="utf-8")
    print(f"valid {len(valid)}  common {len(common)} (tiers {tiers})  excluded {len(excluded)}")
    for name, digest in shipped.items():
        print(f"{name} {(out / name).stat().st_size} bytes sha256 {digest}")


if __name__ == "__main__":
    main()
