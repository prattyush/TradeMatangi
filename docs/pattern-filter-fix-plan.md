# Fix Pattern Library Filter Not Respecting Category

## Two Issues Found

### 1. Gallery Card Metadata Shows Unfiltered Categories & Strategies

**Root cause:** `backend/app/services/pattern_logger_service.py`, `_chart_to_meta_filtered` (lines 186-188) computes `strategy_names` and `categories` from ALL annotations in the chart, ignoring the active filter:

```python
strategy_names = list({a.get("strategy_name", "") for a in raw if a.get("strategy_name")})
categories = list({a.get("category", "") for a in raw if a.get("category")})
```

When filtering by strategy="S1" and category="CatX", the card still shows all strategies and all categories from the chart (including "S2", "CatY") because these lines don't respect the `strategy`/`category` parameters.

**Fix:** When `strategy` or `category` filter is active, compute filtered `strategy_names`/`categories` that only include annotations matching the filter:

```python
if strategy and category:
    matched = [a for a in raw if a.get("strategy_name") == strategy and a.get("category") == category]
elif strategy:
    matched = [a for a in raw if a.get("strategy_name") == strategy]
elif category:
    matched = [a for a in raw if a.get("category") == category]
else:
    matched = raw
strategy_names = list({a.get("strategy_name", "") for a in matched if a.get("strategy_name")})
categories = list({a.get("category", "") for a in matched if a.get("category")})
```

Also adjust `entry_count`/`exit_count` to use the same `matched` list for consistency (they currently have their own inline logic, which is correct but could be simplified).

**File:** `backend/app/services/pattern_logger_service.py`, lines ~184-200

---

### 2. Chart Load in View Mode Clears Gallery Filter Instead of Preserving It

**Root cause:** `frontend/src/pages/PatternLibrary.tsx`, `handleGalleryLoad` (lines ~945-948) explicitly resets both filters in view mode:

```tsx
if (mode === 'view') {
    setActiveStrategy('')
    setActiveCategory('')
}
```

This forces the user to re-apply the same filter they just used in the gallery.

**Fix:** Instead of clearing, set both filters to the gallery filter values:

```tsx
if (mode === 'view') {
    setActiveStrategy(galleryStrategy)
    setActiveCategory(galleryCategory)
}
```

**File:** `frontend/src/pages/PatternLibrary.tsx`, line ~946-948

---

## Verification

1. **Backend tests:** Run `python -m pytest backend/tests/test_pattern_logger.py -v -k "list_charts"` — confirm existing category/strategy filter tests still pass.
2. **Manual test — Issue 1:** In Pattern Library → View mode, select a specific category and strategy. Gallery cards should only show that category's name (not all categories from the chart). Entry/exit counts should also reflect only the matching annotations.
3. **Manual test — Issue 2:** In View mode, filter by a specific category+strategy, then click a chart to load it. The in-chart "Filter:" dropdowns should be pre-populated with the same category and strategy values (not "All categories" / "All strategies"). Dimming should apply accordingly.
4. **Selecting "All categories" or "All strategies"** in the gallery should load charts with those defaults showing all markers.
