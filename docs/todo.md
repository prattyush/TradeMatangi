# TODO (picked up on non-trading days)

Items the owner has not scheduled yet. Each is optional and independent. Update this file when one is done, started or added. Work lands on `dev` through feature branches (see `CLAUDE.md`).

## Games (Phase 25 follow-ups)
Phase 25 code is complete; these remain.

1. **Owner acceptance of the Games**: `docs/phase25-manual-acceptance.md`, sections G to T (Windows build and website). Section N needs `python scripts/build-games-index.py` on each machine that serves the backend (not in git; re-run after a data refresh).
2. **Tune the market games from play** (collect notes while playing, then one small PR per game):
   - Tick Reader `k` (0.4) and costs; Exit Discipline levels 50 and 20; Entry Sniper trap share.
   - Spot the Trap: breakout thresholds (2 and 0.5 volUnit, 12 bars), pattern thresholds, the label overlap of "level" and "fake if it falls back here" on the breakout chart.
   - No-Trade Day: size of 1 R, replay speed, and whether a scratch exit (about 0 R after costs) should count as a loss for the cooldown and revenge rules.
   - Level Recall study times, Strike Picker answers, Regime Switch change rate.
3. **Replay of market sessions by window id** (optional): Review keeps a round log (C42) but no replay. Needs every round source to accept a fixed list of window ids.
4. **Memory check on the Windows build** at level 15 to 20 over a long session (acceptance T5; budget 600 MB).
5. **Real-session tries on `dev`**: the P&L Milestones risk switch (#860), the GuardRails minimum-gap reset (#858) and the Deep Dive percentages in the live label popups (Phase 26 S9, `docs/phase26-manual-acceptance.md` section F). None goes to `preprod` without the owner's real-session try.

## Live volume (Track C, dev only)
Probe results are in `docs/spec-phase24.md`; Kite and Breeze are merged (#855, #856).

6. Run the **Fyers and Kotak volume probes** (the owner runs them), then build those two feeds.
7. Gap-fill ticks, the desktop live stream, the Swing live bar and the frontend handoff (`bar_volume`).

## Other
8. Windows acceptance of Track P (Patterns, Chart Structures and Fine Structures on the desktop): `docs/phase25-manual-acceptance.md`.
9. Phone app (`docs/phone-manual-acceptance.md`): the owner's try of phone swing trading, paper first, is pending.

## Phase 26 (Patterns Strategy Deep Dive)
10. **Owner acceptance of Phase 26**: `docs/phase26-manual-acceptance.md`, sections A to I (desktop rebuild needed; the website and webapp from `dev`; section F covers the real-trading label popups, try replay or stepwise first and real last).
11a. **Strategy Practice** (Phase 26, S12 to S18): built. The owner's acceptance is section M of `docs/phase26-manual-acceptance.md` (rebuild the Windows app, install the new phone APK). Ideas for later, not planned: Stepwise as a second practice mode; practice from days shared with you; per-strategy trend charts of capture % and entry timing.
11. Ideas the owner may want later (not planned): tag notes per day (for example the price level of a double top); a wider side-by-side column for the percentages panel in Label Trades; deep dive days shown on the Analysis day list.

