# Android phone app — manual acceptance (real phone, landscape)

Run on a real phone with the signed debug or release APK. Each sprint adds its section; tick items as they pass. Status of the sprints: `docs/spec-phase24-android-plan.md`.

## A. Install and sign in (S1, S2)
(Filled in when S1 and S2 land.)

## B. Sessions and session detail (S3)
(Filled in when S3 lands.)

## C. Trade labeling (S4)
(Filled in when S4 lands.)

## D. Stats and Habits (S5)
(Filled in when S5 lands.)

## E. Videos (S6)
(Filled in when S6 lands.)

## F. Browse (S7)
(Filled in when S7 lands.)

## G. Positions (S8)
(Filled in when S8 lands.)

## H. Whole-app checks (S9)
- Server switch between `dev`, `preprod` and the phone branch: features the server lacks show "not available", nothing crashes.
- Airplane mode: offline banner, no crash, recovers when the network returns.
- Android back button steps back one level; at the root a second press exits.
- App lock (if turned on) asks on cold start and after a minute in the background.
- Token refresh still works the day after signing in.
