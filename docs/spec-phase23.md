# Phase 23 — Label Trades one-by-one + Manual Behavioral Analysis

**Status: In progress** (Sprint 0 — documentation). Implementation plan and sprint table: [spec-phase23-implementation-plan.md](spec-phase23-implementation-plan.md).

Applies to all three clients: website (`frontend/`), webapp (`webapp/`, which renders the same website code) and desktop (`windowsapp/`). All work lands on `dev` first; nothing here is ported to `preprod`/`main` until reviewed (see `CLAUDE.md` branch strategy).

## 1. Requirements (clarified)

### 1.1 Analysis → Label Trades, one round trip at a time

Today the Label Trades tab lists every round trip in a scrolling right panel, each with its own category/strategy/tag fields, and a chart on the left. Redesign:

1. Right panel shows **one round trip at a time** with category, strategy and tag fields for that trade only; the left panel keeps the chart with buy/sell markers.
2. **Prev / Next** buttons move between round trips. The user keeps pressing Next and entering information.
3. When a trade is viewed, **its markers appear on every chart that shows it**: the Underlying chart and the option-strike (CE/PE) chart of that trade.
4. A setting in **Settings → Analytics** chooses **One at a time** (default) or **All together** (today's list), shared across website, webapp and desktop.
5. Applies to all session types that Label Trades covers today (replay, paper, real, stepwise).
6. Saving is automatic when the user leaves a trade (Next/Prev/close) in one-by-one mode.

### 1.2 Manual Behavioral Analysis

The user labels how many times a behavior was demonstrated in a trading day, e.g. "trade went into profit, stayed in profit for 1 bar, then exited at a loss". Three parts:

1. **Behavior questions** — user writes questions; each has a type, **Entry** (asked when the entry strategy is labeled) or **Exit** (asked when the exit/actual strategy is labeled). Questions can be added, edited, **archived** and **unarchived**. Archived questions stay for history: past marks still show in Stats, but they are no longer asked. Only active questions can be newly marked.
2. **Labeling a trade** — for each round trip the user answers **yes / no** per question ("this trade showed this behavior"). Two places:
   - **During trading** (replay, paper, real; stepwise optional): added to the existing entry-label and exit-label popups/panels (website right panel, desktop left tool panel).
   - **In Analysis → Label Trades**, in the trade's form (entry questions next to the entry fields, exit questions next to the exit fields).
3. **Stats** — a new **Habits** view in the Stats dashboard: a line chart of the number of trades per trading day that showed each behavior, so the user can see whether a behavior is decreasing. Click-through lists the flagged trades.

### 1.3 Decisions and assumptions

| Topic | Decision |
|---|---|
| Answer type | Yes/No per trade (not a counter). Daily count = number of trades marked yes. |
| Entry vs exit | Entry questions in the entry-label step, exit questions in the exit-label step. |
| Desktop real sessions | Desktop gets labeling for real sessions too (backend returned 409 before). |
| Label Trades default | One at a time + auto-save; setting `analysis_label_view` (`one_by_one` \| `all`). |
| Storage | Behavior marks in their own table (see §3) so existing full-overwrite label writes and the real-session label projection cannot clobber them. |
| Swing | Out of scope for v1 (swing has its own label flow in `SwingHistory`). |
| Stats tab name | "Habits" (a "Behavior" tab for automatic metrics already exists). |
| Sharing | Marks are per user; shared real-session history is read-only for viewers. |
| Process | Every sprint updates this document on `dev`. |

## 2. Where things live (existing code, discovered during planning)

- Analysis Label Trades: `shared/analysis/TradeLabeling.tsx` (394 lines; website wrapper `frontend/src/components/TradeLabeling.tsx`; desktop imports the shared file via `GroupCard`). Today save is one bulk "Save Labels" over all trades. Desktop charts use `LabelCharts` = `shared/analysis/kline/AnalysisPanels.tsx`; website shows one chart with pills.
- In-session labeling: website/webapp `frontend/src/components/PendingLabelPanel.tsx` (`LabelPopup`) and `StepwiseLabelPopup.tsx`; desktop `windowsapp/src/App.tsx` (`DesktopLabelPanel`, `DesktopLabelPopup`).
- Stats: `shared/analysis/PerformanceDashboard.tsx` (hand-rolled SVG).
- Desktop analysis transport allowlist exists in three copies: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`. The desktop app must be rebuilt for Rust-side changes.

## 3. Design

### 3.1 Data model (new DynamoDB tables)

- `BehaviorQuestions`: PK `user_id`, SK `question_id`. Attributes `kind` (`entry`|`exit`), `text` (≤140), `status` (`active`|`archived`), `sort_order`, `created_at`, `archived_at`. Never hard-deleted.
- `BehaviorMarks`: PK `session_id`, SK `"{round_trip_index:05d}#{question_id}"`; attributes `user_id`, `date`, `symbol`, `session_type`, `round_trip_index`, `question_id`, `kind`, `marked_at`; GSI `UserIdDateIndex` (`user_id`, `date`). Only "yes" is stored; "no" deletes the row.

### 3.2 API (`/api/behavior`)

`GET questions?include_archived=` · `POST questions` · `POST questions/{id}/update` · `POST questions/{id}/archive` · `POST questions/{id}/restore` · `GET marks?session_id=` · `POST marks` · `GET stats` · `GET marks/by-question`. Desktop reaches the same service through the analysis proxy (analysis screens) and `/api/desktop/v1/trading/...` (in-session).

Rules: text trimmed and unique (case-insensitive) among active questions; kind cannot change once marks exist; at most 40 active questions; only active questions can be newly marked; writes are owner-only.

### 3.3 UI

- **Behavior Questions manager** (one shared component): Entry and Exit sections of active questions, collapsible Archived list. Add (text + type), edit text, **Archive**, **Unarchive**. Reachable from Settings → Analytics (permanent home), Stats → Habits ("Manage questions"), Label Trades header, and the live labeling popups (add only).
- **Label Trades one-by-one**: sticky header "Trade n of N · contract · P&L", Prev/Next (keyboard ←/→), a strip of per-trade dots (P&L colour, ✓ when labeled), form, save status. Phone layout: chart on top, form below, sticky bottom Prev/Next.
- **Live labeling**: entry checklist in the entry-label step, exit checklist in the exit-label step, in the website popup and the desktop popup.
- **Habits**: multi-series line chart per question over trading days (zero-filled from the dashboard's trading days), legend toggles, summary table with last 7 days vs prior, drill-down list.

## 4. Implementation status

| Sprint | Scope | Status |
|---|---|---|
| 0 | Docs and scaffolding | In progress |
| 1 | Backend foundation | Not started |
| 2 | Desktop transport and real labels | Not started |
| 3 | Analysis one-by-one core | Not started |
| 4 | Charts, responsive and webapp | Not started |
| 5 | Behavior questions manager + Analysis marks | Not started |
| 6 | Live labeling | Not started |
| 7 | Habits stats | Not started |
| 8 | Hardening and close-out | Not started |

Details, acceptance criteria and the verification matrix are in [spec-phase23-implementation-plan.md](spec-phase23-implementation-plan.md).

## Appendix — original requirement text (free hand, as written)

> ## Analysis Label Trade
> Want to reformat the look of Label Trades section in the Analysis in both desktop and website and webapp. Instead of showing all of the trades one by one. Right panel will have the trades and place to enter strategy and category and left panel would have the chart to show the buy and sell points like it has now.
>
> Only difference is we will have a next and prev button. Which is markers will appear on left panel for each round trip trade and right panel would have category and strategy options to fill same it has now, but only for the trade in question. User keeps on pressing next and next and enters the information. When a particular trade is viewed, its markers would be present in all the charts, all option strike prices and Underlying.
>
> If needed we can have a setting in Analytics tab whether to see all trades together or one by one for labelling.
>
> ## Manual Behaviorial Analysis
> This requirement, is for user to specifically rank or label a day's trading session, as to how many times a particular behavior was demonstrated. So, lets say the behavior is, :- Trade went into profit stayed in profit for 1 bar and then exited at a loss. After trading is done, user can manually label how mnay times or for how many trades he did this. This information is recorded and showed in stats, a line graph against days for the number of times value per day.
>
> This requirement will have 3 sections:-
> 1. A place where user writes their behavior questions. These questions would be showed back to the user per trade and user can increase the counter for it or not. As we go along more questions can be added or archived. Archived questions for historical storage purposes. User only labels or increases counter for active questions.
> 2. User labeling or increasing counter for the active question per trade. User can increase this counter during live trading just as user can label category and strategy during trade. So, 2 places, option to label trades would be present. a) During live trading, b) In Analysis Tab. Now, if the next and previous round trip trade view and label is chosen, when user chooses a round trip they enter cateory and strategy and then choose the active question or all active questions are listed and then user just presses a button to signify this trade displayed this behavior. At the end the total count of trades where a particular behavior is recorded may be also at trade level is recorded and showed in stats. If next and previous is not there, then right panel will have 2 tabs, category and strategy labeling and behavior labeling, with same info of trade round trip at top and then choosing question and whether to label this trade followed it or not.
> 3. Stats:- Once these behavior labels are recorded, stats can show them in behavior tab or a seperate tab, but main point for user is improve is the count increase or decreases per trading day to ascertain that behavior has changed. So, a line chart with time x axis is preferencial or may be you can use some other better way to plot.
>
> For user labeling behavior during live trading session, just add a drop down menu of active question and ability to select this trade demonstracted or not, to the actual category and strategy recording popup, that is when the trade is finished. User can better label after round trip is finished.
>
> Or better yet, user can have 2 separate type of behavior questions, entry and exit questions. Entry question are asked when expected strategy is entered, and exit questions are displayed when expected strategy is entered during trading popups, when the trade is selecte don right panel in website and left panel in desktop.
>
> Follow-up from the user: behavior labeling during trading must cover replay, paper and real (stepwise optional); Analysis Label Trades applies to all trade types.
