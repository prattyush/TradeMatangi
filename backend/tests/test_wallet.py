"""
Unit tests for wallet_service. DynamoDB writes/reads are patched out.
"""
import pytest
from unittest.mock import patch, MagicMock
from app.services import wallet_service as svc
from app.services.wallet_service import InsufficientFundsError

USER = "abc12300-0000-0000-0000-000000000001"
DATE = "2026-05-06"
DATE2 = "2026-05-07"


@pytest.fixture(autouse=True)
def clean_wallets():
    svc._wallets.clear()
    yield
    svc._wallets.clear()


@pytest.fixture(autouse=True)
def no_db():
    """Patch DynamoDB so tests don't need a running local instance."""
    with patch("app.services.wallet_service._write_wallet_to_db"), \
         patch("app.services.wallet_service._load_from_db", return_value=None):
        yield


class TestGetBalance:
    def test_default_balance_is_150000(self):
        balance = svc.get_balance(USER, DATE)
        assert balance == 150_000.0

    def test_repeated_calls_return_same_value(self):
        svc.get_balance(USER, DATE)
        svc.get_balance(USER, DATE)
        assert svc._wallets[(USER, DATE)] == 150_000.0


class TestDebit:
    def test_debit_reduces_balance(self):
        svc.get_or_init_wallet(USER, DATE)
        balance = svc.debit(USER, 10_000.0, DATE)
        assert balance == 140_000.0

    def test_debit_insufficient_funds_raises(self):
        svc.get_or_init_wallet(USER, DATE)
        with pytest.raises(InsufficientFundsError) as exc_info:
            svc.debit(USER, 200_000.0, DATE)
        assert exc_info.value.balance == 150_000.0
        assert exc_info.value.required == 200_000.0

    def test_debit_zero_amount_no_change(self):
        balance = svc.debit(USER, 0.0, DATE)
        assert balance == 150_000.0

    def test_debit_exact_balance_leaves_zero(self):
        svc.get_or_init_wallet(USER, DATE)
        balance = svc.debit(USER, 150_000.0, DATE)
        assert balance == 0.0


class TestCredit:
    def test_credit_increases_balance(self):
        svc.get_or_init_wallet(USER, DATE)
        balance = svc.credit(USER, 5_000.0, DATE)
        assert balance == 155_000.0

    def test_credit_zero_amount_no_change(self):
        balance = svc.credit(USER, 0.0, DATE)
        assert balance == 150_000.0


class TestReset:
    def test_reset_to_default(self):
        svc.debit(USER, 50_000.0, DATE)
        balance = svc.reset(USER, DATE)
        assert balance == 150_000.0

    def test_reset_to_custom_amount(self):
        balance = svc.reset(USER, DATE, 200_000.0)
        assert balance == 200_000.0

    def test_reset_overwrites_existing(self):
        svc.get_or_init_wallet(USER, DATE)
        svc.debit(USER, 100_000.0, DATE)
        balance = svc.reset(USER, DATE, 50_000.0)
        assert balance == 50_000.0


class TestCarryForward:
    def test_carry_forward_from_prior_date(self):
        """When a prior record exists, new date initialises with that balance."""
        prior_balance = 120_000.0
        with patch("app.services.wallet_service._write_wallet_to_db"), \
             patch("app.services.wallet_service._load_from_db", return_value=prior_balance):
            balance = svc.get_balance(USER, DATE2)
        assert balance == prior_balance

    def test_no_prior_record_uses_default(self):
        with patch("app.services.wallet_service._write_wallet_to_db"), \
             patch("app.services.wallet_service._load_from_db", return_value=None):
            balance = svc.get_balance(USER, DATE2)
        assert balance == 150_000.0

    def test_carry_forward_not_re_queried_after_init(self):
        """Second access hits in-memory cache, not DynamoDB."""
        with patch("app.services.wallet_service._write_wallet_to_db"), \
             patch("app.services.wallet_service._load_from_db", return_value=120_000.0) as mock_load:
            svc.get_balance(USER, DATE2)
            svc.get_balance(USER, DATE2)
        mock_load.assert_called_once()
