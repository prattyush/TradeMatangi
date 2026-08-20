## Enhancements-2


### Override session
This idea is that for simulation and stepwise sessions, one can override the previous session and all its data. This can be included as a settings to whether enable this feature or not. When, enabled, if a user is starting a simulation or a stepwise session, it would check if the same symbol, same type (equity/option), same date etc was previously run, if yes and if the setting is enabled, then it would ask user whether to override previous session. If user responds with yes, then delete all previous trades, delete all labels of those trades and also delete any wallet entries for that combination or previous sessions. It selected, yes, the all previous session for that exact combination (date, symbol, type, session type(simulation/stepwise), trading type(options/equity)).

During this can you also update the settings UI to separate the sections EVENT SNAPSHOTS, TRADE LABELING MODE, TRADE ANALYSIS PRICE SOURCE, PATTERN SHARING into a new tab called as A&P or analsis & patterns or others (whichever makes more sense, or you can choose your own name). Just that the settings of General Tab is becoming too long.

### UI Layout

---

## Implementation Status

**Status:** ✅ Complete

### Files Changed

**Backend:**
| File | Change |
|------|--------|
| `backend/app/models/schemas.py` | Added `override_session_enabled` to `UserSettingsResponse` and `UserSettingsUpdateRequest`; added `override: bool = False` to `SimulationStartRequest` |
| `backend/app/services/user_settings_service.py` | Added `"override_session_enabled": False` to `DEFAULT_SETTINGS` |
| `backend/app/services/session_cleanup_service.py` | **New** — cascade delete service: `delete_session_cascade()` deletes Trades, Orders, Strategies, TradeLabels, EventSnapshots, AICommands, AIDecisionLog, Sessions record, and wallet entry |
| `backend/app/services/wallet_service.py` | Added `delete_entry(user_id, date)` to remove wallet record from DynamoDB and in-memory cache |
| `backend/app/routers/simulation.py` | Added `override` flag handling in `start_simulation()`; added `GET /api/simulation/check-existing` endpoint |

**Frontend:**
| File | Change |
|------|--------|
| `frontend/src/components/SettingsModal.tsx` | Added "Analysis & Patterns" tab; moved EVENT SNAPSHOTS, TRADE LABELING MODE, TRADE ANALYSIS PRICE SOURCE, EXPERIMENTAL FEATURES, PATTERN SHARING from General tab to new tab; added OVERRIDE PREVIOUS SESSIONS toggle to General tab; added `loadOverrideSessionEnabled` helper |
| `frontend/src/components/SessionControls.tsx` | Added `overrideSessionEnabled` prop; added override confirmation flow in `_doStart()` |
| `frontend/src/hooks/useSimulation.ts` | Added `override?: boolean` to `InstrumentConfig` |
| `frontend/src/services/api.ts` | Added `override` to `SimulationStartRequest`; added `override_session_enabled` to `UserSettingsResponse`; added `checkExistingSession()` API function |
| `frontend/src/App.tsx` | Added `overrideSessionEnabled` state; passes prop to `SessionControls` |

**Tests:**
| File | Change |
|------|--------|
| `backend/tests/test_session_cleanup.py` | **New** — 7 tests: cascade delete (session record, wallet, snapshots, trades batch delete), wallet delete_entry (cache removal, missing entry, DB error) |
| `backend/tests/test_user_settings.py` | Added 3 tests: default constant, GET includes field, PUT accepts field |

### How It Works

1. **Setting:** User enables "Override Previous Sessions" in Settings → General tab (persisted to DynamoDB + localStorage)
2. **Session Start:** When starting a sim/stepwise session, if setting is enabled:
   - Frontend calls `GET /api/simulation/check-existing` to check for existing session
   - If found, shows `window.confirm()` dialog: "A previous {type} session exists for {symbol} on {date}. Override it and delete all its data?"
   - If confirmed, passes `override: true` in the start request
3. **Cascade Delete:** Backend `delete_session_cascade()` deletes all data for the previous session across 8 DynamoDB tables + wallet entry
4. **New Session:** Fresh session is created with no connection to the previous session

### Verification

1. Enable override setting in Settings → General tab
2. Start a simulation session for NIFTY on a specific date
3. Stop the session
4. Start another simulation for the same NIFTY + date → should see confirmation dialog
5. Confirm override → old session data deleted, new session starts fresh
6. Verify old trades/labels/wallet are gone
7. Verify without the setting enabled, no dialog appears (current behavior preserved)
8. Backend tests: `cd backend && python -m pytest tests/ -v` (700 pass, 8 pre-existing failures)
9. TypeScript check: `cd frontend && node node_modules/typescript/bin/tsc --noEmit` ✅
