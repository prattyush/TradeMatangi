### Desktop Tools

This contains tools which will be created to support trading.

#### Trading Video Maker

##### Context
So, when we click on recording in the website, it records the screen and then it saved it as webm file. First, the webm files don't have a way to skip or go forward, I mean it doesn't have a bar that I can drag to fast forward or reverses. The 2nd problem is trading much of the time is idle, and so most of the time the video is present is of targing chart moving ohlc data, so, while reviewing through video, I have to wait to see where the trades were taken place.

##### Requirement
The requirement is to have a tools section in desktop for now, which will have this trading video editor tool. In summary it should produce a video output, which will be limited only to the trading windows, that is the time between actual entries and exits were done, and probably with a lag and lead time like 1 bar. For example we recorded video from 09:20 to 10:10 and took 3 trades, one at 09:30 to 09:38, then another at 09:39 to 09:45 and last one at 09:57 to 10:02, then at the video should have only the timings, 09:27 to 09:48 and then from 09:54 to 10:06, when candle interval chooses is 3 mins, then before each trade, previouos bar should be in video, so starts at 09:27, and so, as 2 trades were taken simulatenously closeby so due to lead and lag overlap, we have continuous video.

Also. it should be able to do following things:-
1. Firstly, it will be only in desktop as it needs to use the RAM and processor of the host computer to do the computation and work, website can't support this, doing it in server will cause
bigger issues with sharing resources for other tasks.
2. It would take input the webm file and then convert it into a format where we can go ahead and back in the video, is it possible to convert to mp4.
3. Then it can take the webm file of mp4 file and the type of trading this video is for, which date, and if this date has multiple sessions, it will ask for which session. For all is also a valid value.
4. For paper trading and real trading videos, it would take a sync second time, I mean to notify when is videos 01:00 (1 minute) time correspond to real world time is it 09:15, 09:19:32 what. User can choose video sync time and actual trading time, then the system should be able to co-related with trades taken that date or session with video times, and cut the videos.
5. For replay trading, it would take 2 sync times, because it also needs to calculate the speed of replay, or may be it can get the replay speed from somewhere else.
6. It woudl query backend to get the trades taken for that session, for paper and real it is whole day and then cut the video at required time. 
7. If the video finishes, and more trades are present after that, then fine.

These videos would be uploaded to youtube, so it would also need, 
a) The description so that the video has those bars, where user can jump to extract trade. Similar to this:- 
0:00 Introduction
2:15 Unboxing the Product
5:40 How to Setup
9:12 Performance Review 
The description should say trade id (1,2,3 ..) and P&L % of that round trip trade.

b) These details would be provided along with the finished video to the user to be uploaded to youtube.

Choose Ui as you wish, on professional side and matching desktop styling. Add the tools options in the dropdown menu same as analysis etc.

##### Additions (2026-11-09, requested after the first release)
The sections above are the original requirements. These were added later, in chat, and are tracked in `docs/spec-phase24-youtube-plan.md`.
1. **Upload to YouTube from the desktop.** The user signs in with Google; the app asks only for the permission to upload (`youtube.upload`). The finished mp4 is uploaded with its title and the chapter description. Default visibility is Private. The token stays on the PC (Windows Credential Manager).
2. **Keep the links.** Each uploaded video's link is saved on the server against the trading session(s) it covers, so it can be found again and shown on other devices.
3. **Play in the desktop.** The finished mp4 plays inside the desktop app, with the chapters as clickable seek points. Playback is of the local file; the YouTube copy opens in the browser.
4. **Recording stops with the session.** A screen recording stops by itself 10 seconds after the trading session ends (website and desktop; dev only for now).

Status of these: Connect YouTube (#789), recording auto-stop (#790) and upload (#791) are merged; saved links, with the videos shown in Analysis on website and desktop, are in review; the player is planned as the last PR (see the implementation plan status table).


#### GuardRails: Max per entry and Minimum gap between orders

##### Requirement (2026-11-09)
Two guardrails are added to the GuardRails settings (website Settings window and desktop Settings). Both apply to simulated, replay, stepwise, paper and real sessions, to day trading only, and are off by default.

1. **Max per entry** (in the MAX SIZE section). A cap on how large one new entry may be. It is set as a % of capital or an exact rupee value, with its own Enabled checkbox. An entry larger than the cap is **reduced** to it, not rejected: with 24% selected as the order size and a 12% cap, the order is placed at 12%. The cap is measured the way MAX SIZE measures capital in use (full premium for options, 20% margin for intraday equity) and rounds down to whole lots. It applies to every new entry whatever the sizing mode (funds %, risk %, typed quantity, target-profit sizing, AutoStop, desktop orders). Exits are never reduced, and a reversal only has its new part reduced. If even one lot or share costs more than the cap, the entry is rejected with a `MAXSIZE: one lot costs ...` message. The total MAX SIZE limit still applies afterwards. The original quantity is kept in the order analytics as `entry_cap_requested_qty`.
2. **Minimum gap between orders** (new section). A number input in whole minutes (1 to 390) with an Enabled checkbox. A new entry placed sooner than that many minutes after the previous entry was **filled** is refused with a `MINGAP: next entry allowed in N min` message. It covers entries only (a new position, an add, or a reversal); exits, stoplosses and square-offs are never held back. The clock is the session clock, so replay and stepwise sessions follow simulated time. The check runs when the order is placed, not when a pending limit or target order later fills, so a fill is never refused. Because the clock is the fill, several pending entries can be placed before the first one fills.

Both are settings keys on the user's settings record (`guardrail_maxentry_*`, `guardrail_mingap_*`), copied onto the session when it is created like the other guardrails, and enforced on the server so the website, the desktop and AutoStop behave the same.

Status: built on `dev` (backend `guardrail_service.py`, orders and direct trade routes, AutoStop; website and desktop settings); tests in `backend/tests/test_guardrail_maxentry_mingap.py` and `windowsapp/src/guardrailSettings.test.ts`.


#### More symbols: Midcap 50 and sectoral index constituents

##### Requirement (2026-11-10)
Add the stocks in NIFTY MIDCAP 50, NIFTY AUTO, NIFTY FMCG, NIFTY IT, NIFTY BANK, NIFTY METAL and NIFTY OIL & GAS to the symbol list on the website, the desktop and the webapp. A company already in the catalogue (the pinned Nifty 100, `backend/app/resources/nifty100.json`) is left alone. The three clients read one list (`/api/data/symbols`, the desktop catalogue), so one server change covers all of them.

1. **Scope: 72 new stocks.** Constituents were taken from the official `niftyindices.com` `ind_nifty*list.csv` files (2026-11-10) and compared by ISIN with the Nifty 100: all 50 of Midcap 50; Auto +2 (SONACOMS, UNOMINDA); FMCG +5 (COLPAL, GODFRYPHLP, PATANJALI, RADICO, UBL); IT +3 (COFORGE, MPHASIS, OFSS); Bank +0; Metal +4 (HINDCOPPER, JSL, LLOYDSME, SAIL); Oil & Gas +8 (ATGL, AEGISLOG, AEGISVOPAK, CASTROLIND, CHENNPETRO, IGL, MGL, PETRONET). The index symbols themselves (NIFTY BANK and so on) are not added; only their companies.
2. **Where they live.** A second pinned snapshot, `backend/app/resources/index_extras.json` (same row shape as `nifty100.json`, plus the indices a stock belongs to), loaded by `config.py` next to the Nifty 100. `nifty100.json` is not edited, so its test (exactly 100) stays valid. Kite and Kotak name maps are built from the same rows. Rows are produced by a manual script (`scripts/update_index_extras.py`); there is no automatic refresh from NSE.
3. **Options.** A stock gets options only if the current Kite/Breeze derivative masters list it; lot size and strike step come from them. Nothing is guessed. The cached Kite list showed no F&O for UBL, HINDCOPPER, JSL, LLOYDSME, ATGL, AEGISLOG, AEGISVOPAK, CASTROLIND, CHENNPETRO, IGL and MGL; the script re-downloads the masters before deciding.
4. **Broker validation (read-only, no orders).** Kite and ICICI Breeze: instrument mapping, a quote and one day of 1-minute history for the new symbols (tokens from DDB Local). Kotak Neo: the same check for every symbol in the list (the five originals, the Nifty 100 and the 72 new ones) against Kotak's `nse_cm` master. Anything Kotak lacks is recorded below as a limitation (Kotak trading or streaming is not offered for it; Kite and Breeze still work); it is never left to fail silently.

##### Broker validation results (2026-11-10, market open, read-only)
Run with `scripts/check-nifty100-providers.py --catalogue extras|all` (mapping and live quote) and `scripts/check-history-volume-probe.py` (one day of 1-minute candles, 2026-11-09). Raw output is in `.cache/index-extras/`.

| Check | Kite | ICICI Breeze | Kotak Neo |
|---|---|---|---|
| Instrument mapping, 72 new stocks | 72 / 72 | 72 / 72 (matched by ISIN) | covered by the quote check |
| Live quote, 72 new stocks | 72 / 72 | 72 / 72 | 72 / 72 |
| Live quote or token, **every** symbol in the list (2 indices, Nifty 100, 72 new = 174) | - | - | 174 / 174 |
| 1-minute history, sample of 9 (NIFTY, NAUKRI, UBL, SAIL, IGL, SONACOMS, COFORGE, AUBANK, RELIND) | 9 / 9 | 8 / 9 verified, 1 not completed (see below) | 8 / 9 (NIFTY not supported) |

- **Kotak supports every symbol in the list** for instrument lookup and quotes. No symbol had to be removed or remapped.
- **Kotak history does not support the NIFTY index** (`Invalid neosymbol` for `nse_cm|26000`). This is how Kotak's history API behaves for indices, not a catalogue problem; the history policy already falls back from Kotak to Kite and Breeze. Stocks work (NAUKRI, UBL, SAIL, IGL, SONACOMS, COFORGE, AUBANK, RELIND all returned about 352 to 360 candles). Kotak throttles history at roughly one request every few seconds (HTTP 429); the production pacer handles it.
- **Breeze history:** IGL, NAUKRI, UBL, SAIL, SONACOMS, COFORGE, AUBANK, RELIND and NIFTY returned candles. Connections from this machine to `breezeapi.icicidirect.com` timed out intermittently during the run; MGL's history call did not complete for that reason (its mapping and quote passed).
- **Volume is returned by all three providers** for stocks (non-zero in 351 to 361 of about 360 candles) and is zero for the NIFTY index, which is what the volume work below relies on.
- **Options:** 61 of the 72 have options (Kite lists a stock option and Breeze lists the same stock code). Without options: UBL, HINDCOPPER, JSL, LLOYDSME, ATGL, AEGISLOG, AEGISVOPAK, CASTROLIND, CHENNPETRO, IGL, MGL (none was listed by Kite's current F&O master).
- **Symbol picker:** the shared `SymbolSearch` (website, desktop, webapp) already searches by name and NSE symbol, so about 177 entries need no UI change.

Status: built on `dev` (`index_extras.json`, `scripts/update_index_extras.py`, `config.py`, tests in `backend/tests/test_index_extras_catalogue.py`). Re-run the update script to refresh; there is no automatic refresh.


#### Volume in OHLC data

##### Requirement (2026-11-10)
Evaluate and add volume to the historical data fetched from Kite and ICICI Breeze (and Kotak), stored with it, and served to day trading and swing; and evaluate it for real-trading candles. Display is a `VOL` indicator on the KLine chart (website, desktop, webapp); the older Lightweight chart is unchanged.

##### Evaluation
- **Fetched and stored already.** Kite, Breeze and Kotak history all return volume and the history frames keep it. Every cached day file on this machine (255 parquet files and the legacy pickle) already has a `volume` column; no refetch or backfill is needed. Indices carry no volume (zero); options and equities do.
- **Lost on read.** The day-trading loaders (`data_loader._load_breeze_dataframe`, `options_service._load_breeze_options_dataframe`, `historical_data_service._normalize`) keep only open/high/low/close, `resample_to_candles` does not sum volume, and the API candle models (`OHLCCandle`, `DesktopCandle`, `OHLCItem`) have no volume field.
- **Swing already carries volume** in history (`swing_charts`), summed per bucket. Its live bar and the quote merge do not.
- **Gap-fill would invent volume.** The second-level gap-fill forward/back-fills every column, so a filled second would show traded volume. Rows with `observed = false` must have volume 0.
- **Real trading has none today.** Every live adapter (Kite, Kotak, Breeze, Fyers) turns ticks into 1-second OHLC and discards everything else; Kite is subscribed in LTP mode. Providers report a cumulative day total, so a bar's volume is a difference, not a sum of ticks. Reconnects, provider failover and option strike changes can create a false spike, and indices have no volume at all. No live candles are stored on the server; the desktop's local `desktop_live_ticks.volume` column exists but is never written.

##### Decision
1. **B1 (this work):** keep volume through history, replay, stepwise, the website and desktop APIs and swing; add the `VOL` indicator (and make VWAP usable) for instruments that have volume. Volume is the sum per bar; indices report no volume (null, not 0); gap-filled seconds are 0; older cached files without the column still load.
2. **B2 (later, gated):** live volume for real and paper trading. First a read-only probe of the real Kite (quote mode), Breeze, Kotak and Fyers payloads during market hours; findings are written here before any code. Real-trading orders, stoplosses and square-offs never depend on volume. Not promoted to `preprod` without the user's real-session test.

Status: B1 planned. B2 waits for the live probe.
