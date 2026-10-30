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
        assert get_max_contracts("NIFTY") == 3510

    def test_nifty_with_expiry_suffix(self):
        assert get_max_contracts("NIFTY25JUN23500CE") == 3510

    def test_sensex(self):
        assert get_max_contracts("SENSEX") == 1000

    def test_sensex_with_suffix(self):
        assert get_max_contracts("SENSEX25JUN80000CE") == 1000

    def test_banknifty(self):
        assert get_max_contracts("BANKNIFTY") == 1440

    def test_unknown_symbol_returns_equity_cash_cap(self):
        # NSE cash-equity per-order cap (50,000 shares), not "unlimited".
        assert get_max_contracts("RELIANCE") == 50_000

    def test_case_insensitive(self):
        assert get_max_contracts("nifty") == 3510


class TestSplitQuantity:
    def test_no_split_needed(self):
        assert split_quantity("NIFTY", 1800) == [1800]

    def test_no_split_below_limit(self):
        assert split_quantity("NIFTY", 500) == [500]

    def test_nifty_8000_splits_to_3_chunks(self):
        chunks = split_quantity("NIFTY", 8000)
        assert chunks == [3510, 3510, 980]
        assert sum(chunks) == 8000

    def test_nifty_exact_multiple(self):
        chunks = split_quantity("NIFTY", 7020)
        assert chunks == [3510, 3510]
        assert sum(chunks) == 7020

    def test_sensex_3000(self):
        chunks = split_quantity("SENSEX", 3000)
        assert chunks == [1000, 1000, 1000]
        assert sum(chunks) == 3000

    def test_sensex_2500(self):
        chunks = split_quantity("SENSEX", 2500)
        assert chunks == [1000, 1000, 500]
        assert sum(chunks) == 2500

    def test_equity_below_cash_cap_never_splits(self):
        assert split_quantity("RELIANCE", 10_000) == [10_000]

    def test_equity_above_cash_cap_splits(self):
        # NSE cash-equity per-order cap is 50,000 shares.
        chunks = split_quantity("RELIANCE", 100_000)
        assert chunks == [50_000, 50_000]
        assert sum(chunks) == 100_000

    def test_single_lot(self):
        assert split_quantity("NIFTY", 1) == [1]
