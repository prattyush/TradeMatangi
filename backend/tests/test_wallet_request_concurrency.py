"""Slow wallet storage must not block chart/other API requests on startup."""
import asyncio
import time
from threading import Event

import httpx
import pytest

from app.main import app
from app.services import practice_wallets


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/wallet?date=2026-10-09&mode=paper&include_reset_status=true", "/api/desktop/v1/trading/wallet?date=2026-10-09&desktop_mode=paper"])
@pytest.mark.parametrize("slow_part", ["read", "blocked"])
async def test_wallet_storage_does_not_block_other_requests(monkeypatch, slow_part, path):
    entered = Event()
    def read(*args):
        if slow_part == "read":
            entered.set()
            time.sleep(.4)
        return {"current_balance": 150000}
    def blocked(*args):
        if slow_part == "blocked":
            entered.set()
            time.sleep(.4)
        return None
    monkeypatch.setattr(practice_wallets, "read", read)
    monkeypatch.setattr(practice_wallets, "blocked", blocked)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        started = time.monotonic()
        wallet = asyncio.create_task(client.get(path, headers={"X-User-Id": "concurrency-user"}))
        while not entered.is_set():
            if wallet.done():
                result = await wallet
                pytest.fail(f"Wallet storage was not reached: {result.status_code} {result.text}")
            assert time.monotonic() - started < 2, "Wallet request did not reach storage"
            await asyncio.sleep(.001)
        response = await client.get("/health")
        elapsed = time.monotonic() - started
        await wallet
    assert response.status_code == 200
    assert elapsed < .25, f"Wallet storage blocked unrelated requests for {elapsed:.3f}s"


@pytest.mark.asyncio
async def test_toolbar_balance_skips_reset_scan_and_settings_requests_it(monkeypatch):
    calls = []
    monkeypatch.setattr(practice_wallets, "read", lambda *args: {"current_balance": 180000})
    def blocked(*args):
        calls.append(args)
        return "Paper Stop cleanup pending"
    monkeypatch.setattr(practice_wallets, "blocked", blocked)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        balance = await client.get("/api/wallet?date=2026-10-09&mode=paper")
        assert balance.json()["balance"] == 180000
        assert balance.json()["reset_allowed"] is None
        assert calls == []
        status = await client.get("/api/wallet?date=2026-10-09&mode=paper&include_reset_status=true")
        assert status.json()["reset_allowed"] is False
        assert status.json()["reset_reason"] == "Paper Stop cleanup pending"
        assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/wallet/reset?date=2026-10-09&mode=paper", "/api/desktop/v1/trading/wallet/reset?date=2026-10-09&desktop_mode=paper"])
async def test_wallet_reset_storage_does_not_block_other_requests(monkeypatch, path):
    entered = Event()
    def reset(*args):
        entered.set()
        time.sleep(.4)
        return 180000
    monkeypatch.setattr(practice_wallets, "reset", reset)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        started = time.monotonic()
        wallet = asyncio.create_task(client.post(path, json={"amount": 180000}, headers={"X-User-Id": "concurrency-user"}))
        while not entered.is_set():
            if wallet.done():
                result = await wallet
                pytest.fail(f"Wallet storage was not reached: {result.status_code} {result.text}")
            assert time.monotonic() - started < 2, "Wallet request did not reach storage"
            await asyncio.sleep(.001)
        response = await client.get("/health")
        elapsed = time.monotonic() - started
        result = await wallet
    assert response.status_code == result.status_code == 200
    assert result.json()["balance"] == 180000
    assert elapsed < .25


@pytest.mark.asyncio
async def test_google_signin_completes_while_wallet_storage_waits(monkeypatch):
    from app.routers import auth
    entered = Event()
    def read(*args):
        entered.set()
        time.sleep(.4)
        return {"current_balance": 150000}
    monkeypatch.setattr(practice_wallets, "read", read)
    monkeypatch.setattr(auth, "google_auth", lambda *args, **kwargs: {"user_id": "google-user", "email": "g@example.com", "account_name": "Google User"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        started = time.monotonic()
        wallet = asyncio.create_task(client.get("/api/wallet?date=2026-10-09&mode=paper"))
        while not entered.is_set():
            assert time.monotonic()-started < 2
            await asyncio.sleep(.001)
        login = await client.post("/api/auth/google", json={"id_token": "synthetic-id-token"})
        elapsed = time.monotonic()-started
        await wallet
    assert login.status_code == 200
    assert login.json()["user_id"] == "google-user"
    assert elapsed < .25
