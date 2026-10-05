# Desktop screen autosave repair — 2026-10-05

Continuous `PUT /api/desktop/v1/screens/{id}` requests while a screen is idle can be caused by comparing raw JSON strings. Object-key order can change across Rust/server round trips. Applying the returned screen creates a new React state object, and the different JSON ordering causes the 700 ms autosave effect to save again.

The repair compares canonical JSON content for autosave fingerprints, conflict detection, save reconciliation and recovery-journal cleanup. Object keys are sorted recursively; arrays retain their meaningful order. Undefined object fields follow normal JSON transport behavior, so an omitted server field does not appear to be an unsaved edit.

Queued saves sample the latest persisted record and desired screen state when they execute. If those contents already match, the save returns the persisted record without another PUT. Actual edits made while an earlier save is in flight are still merged and saved. Protected lifecycle conflicts retain their existing handling.

Validation: **152 desktop tests passed**, including six new regression cases for reordered keys, omitted fields, array order, conflict detection, redundant queued saves, and edits during an in-flight save. Desktop TypeScript and `git diff --check` passed.

This is a desktop frontend change. An updated Windows desktop build is required to apply it to the installed app. Verification: leave an unchanged screen running, confirm screen PUT requests stop after its first save, then change a layout/indicator and confirm one save occurs. Check that pending edits and recovery state survive slow saves and reconnects.
