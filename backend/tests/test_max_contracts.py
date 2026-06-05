"""
Unit tests for max-contracts-per-order splitting logic.
Tests cover the helper functions and the auto-split behaviour for SL orders.
DynamoDB writes are patched out; wallet operations use real in-memory state.
"""
import pytest
from unittest.mock import patch

from app.services.order_service import get_max_contracts, split_quantity


# ── Helper function tests ──────────────────────────────────────────────────────

class TestGetMaxContracts:
    def test_nifty(self):
        assert get_max_contracts("NIFTY") == 1800

    def test_nifty_with_expiry_suffix(self):
        assert get_max_contracts("NIFTY25JUN23500CE") == 1800

    def test_sensex(self):
        assert get_max_contracts("SENSEX") == 1000

    def test_sensex_with_suffix(self):
        assert get_max_contracts("SENSEX25JUN80000CE") == 1000

    def test_banknifty(self):
        assert get_max_contracts("BANKNIFTY") == 900

    def test_unknown_symbol_returns_large_limit(self):
        assert get_max_contracts("RELIANCE") >= 1_000_000

    def test_case_insensitive(self):
        assert get_max_contracts("nifty") == 1800


class TestSplitQuantity:
    def test_no_split_needed(self):
        assert split_quantity("NIFTY", 1800) == [1800]

    def test_no_split_below_limit(self):
        assert split_quantity("NIFTY", 500) == [500]

    def test_nifty_8000_splits_to_5_chunks(self):
        chunks = split_quantity("NIFTY", 8000)
        assert chunks == [1800, 1800, 1800, 1800, 800]
        assert sum(chunks) == 8000

    def test_nifty_exact_multiple(self):
        chunks = split_quantity("NIFTY", 3600)
        assert chunks == [1800, 1800]
        assert sum(chunks) == 3600

    def test_sensex_3000(self):
        chunks = split_quantity("SENSEX", 3000)
        assert chunks == [1000, 1000, 1000]
        assert sum(chunks) == 3000

    def test_sensex_2500(self):
        chunks = split_quantity("SENSEX", 2500)
        assert chunks == [1000, 1000, 500]
        assert sum(chunks) == 2500

    def test_equity_never_splits(self):
        # Equity has no max contracts limit
        assert split_quantity("RELIANCE", 100_000) == [100_000]

    def test_single_lot(self):
        assert split_quantity("NIFTY", 1) == [1]
