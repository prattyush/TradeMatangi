"""Execution routing is pinned to the session, never to its market-data feed."""
from typing import Protocol


class ExecutionBroker(Protocol):
    def is_authenticated(self) -> bool: ...
    def account_identity(self) -> str: ...
    def get_order_history(self) -> list[dict]: ...
    def get_trade_history(self) -> list[dict]: ...
    def get_positions(self) -> list[dict]: ...
    def get_limits(self) -> dict: ...


def name(value=None) -> str:
    if not isinstance(value, str):
        value = getattr(value, 'execution_broker', None)
    value = value or 'kotak'
    if not isinstance(value, str):
        raise ValueError('Session execution broker identity is invalid')
    aliases = {'KotakNeo': 'kotak', 'Kite': 'kite', 'Zerodha': 'kite'}
    value = aliases.get(value, value)
    if value not in ('kotak', 'kite'):
        raise ValueError('Execution broker must be kotak or kite')
    return value


def get_service(session=None, *, allow_expired=False):
    if not allow_expired and getattr(session, "real_verified_closed", False) is True:
        raise RuntimeError("This Real book is verified closed; broker operations are unavailable")
    if not allow_expired and getattr(session, "real_engine_lease_required", False) is True:
        import time
        if time.monotonic() >= session.real_engine_valid_until:
            raise RuntimeError("Real engine ownership expired; reconnect to the authoritative session")
    if name(session) == 'kotak':
        from app.services.kotak_service import get_service as kotak
        broker = kotak()
    else:
        from app.services.kite_execution import get_service as kite
        broker = kite()
    expected = getattr(session, 'broker_account_id', None)
    if isinstance(expected, str) and expected and not allow_expired and broker.account_identity() != expected:
        raise RuntimeError('Broker account changed; restore the original account before operating this session')
    if getattr(session, "trading_style", None) == "swing":
        portfolio_id = getattr(session, 'portfolio_id', None)
        if isinstance(portfolio_id, str) and session.session_id != portfolio_id:
            from app.services.swing_portfolio_store import owned
            portfolio = owned(session.user_id, portfolio_id)
            if not allow_expired and portfolio["state"] == "ended":
                raise RuntimeError("This Swing portfolio is closed; view its archived history")
            if session.session_id not in portfolio['contexts'].values():
                raise RuntimeError('Swing context registration is incomplete; reconnect before broker operations')
        from app.services.swing_execution_broker import bind
        return bind(broker, session.instrument_type, getattr(session,"future_contract",None))
    return broker


def account_scope(broker):
    identity = broker.account_identity()
    if not isinstance(identity, str) or not identity:
        raise ValueError('Broker account identity is missing')
    return f'{name(getattr(broker, "execution_broker", None))}:{identity}'
