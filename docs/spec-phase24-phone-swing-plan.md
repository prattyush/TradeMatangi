# Phone app — Swing trading (phase 2, S8)

Requirement and decisions: `docs/spec-phase24.md` ("PHONE SWING TRADING"). Architecture of the app: `docs/architecture-phone.md`. Data: Browse and the position charts read minute candles (`docs/live-history-providers.md`).

## Scope
- **In:** the Swing portfolio, paper and real (real only with real-trading access and the App lock on): see positions and pending orders, enter and exit **equity, options and futures** (long and short futures), edit and cancel orders, start a portfolio, pause / resume entries, close the portfolio, a minute chart for a position.
- **Out (later):** Day-trading positions, alerts, email OTP, real funding / import / allocation / reconcile (website and desktop), reset capital.

## How it talks to the server
The swing routes at `/api/desktop/v1/swing/portfolios/*` are the website's handlers behind Bearer auth, so the phone needs no new trading endpoint. Used: `GET capabilities`, `GET broker-status`, `GET active?mode&execution_broker`, `GET {id}`, SSE `{id}/events`, `POST` (start), `POST {id}/order-preview`, `POST {id}/orders`, `PATCH {id}/orders/{oid}`, `POST {id}/orders/{oid}/amend-preview`, `POST {id}/orders/{oid}/cancel`, `POST {id}/pause`, `POST {id}/close`, `GET contracts/metadata`, `GET contracts/futures`, `POST {id}/charts/history`. Server change: the order's `client` accepts `phone` (an attribution tag; it never changes an order's identity).

## Order rules the phone follows (same as the website panel)
- No market orders: a price is always sent. Entry = BUY LIMIT or TARGET; exit = SELL LIMIT or SELL STOPLOSS (equity and options are long only). **Futures:** BUY opens a long or covers a short, SELL opens a short or exits a long; an order against an existing opposite position is an exit (LIMIT or STOPLOSS), otherwise an entry (LIMIT or TARGET).
- `request_id` is generated once per set of instructions and reused when the same instructions are sent again; changing any field starts a new one. Writes are never retried automatically; a `502` ("needs review") means the broker state is uncertain: refresh and look, never resubmit blindly.
- Capital-% sizing and every futures order go through `order-preview` first; the order carries the preview's `capital_revision` (and for futures `approved_budget` and `fee_hash`). A change of any input discards the preview.
- Options are whole lots; prices snap to the contract tick (`shared/swingOrderPrice.ts`).

## Safety
- Every order is confirmed in a **summary sheet** (instrument, side, quantity / lots, type, price, estimated value, PAPER or REAL in large type, for futures the margin from the preview).
- Real: the App lock must be on; the phone's lock is asked when a real portfolio is started or attached and when it is closed.
- A pending order, position and P&L always show the server's state; the screen follows the portfolio's event stream and says "Waiting for prices" instead of 0 when a mark is missing.
- Live-broker acceptance of swing is still pending on the user's side; real swing from the phone is tried only after paper is accepted, on `preprod`.

## Sprints
| Sprint | Scope | Status |
|---|---|---|
| SW0 | Docs (this file, spec) | Done |
| SW1 | Server: order tag `phone` | Done |
| SW2 | Phone model and API: types, calls, stream, order-ticket rules, error messages (unit tests) | Done |
| SW3 | Swing tab: portfolio header, positions, pending orders, start / pause / close | Done |
| SW4 | Order ticket and summary sheet (equity, options), edit / cancel | Done |
| SW4b | Futures: contracts, margin preview, short / cover, closing acknowledgements | Done |
| SW5 | Position chart, 4-size UI tests, acceptance doc, APK, PR | Built; waits for the user's try on a phone (paper first, then real on `preprod`) |
