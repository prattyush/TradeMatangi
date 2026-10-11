"""Immutable delivery/overnight routing over the existing account broker connection.

Binding a product never changes the shared service's MIS defaults or callbacks.
This adapter does not start a portfolio or perform any broker write by itself.
"""

from dataclasses import dataclass


def validate_product(product, options):
    from app.services.kotak_service import KotakOrderRejected

    if product not in ("MIS", "NRML" if options else "CNC"):
        raise KotakOrderRejected(
            "Equity requires CNC/MIS; long options require NRML/MIS"
        )


@dataclass(frozen=True)
class DeliveryBroker:
    base: object
    product: str

    def __post_init__(self):
        if self.product not in ("CNC", "NRML"):
            raise ValueError("Swing uses delivery or overnight products")

    def __getattr__(self, name):
        return getattr(self.base, name)

    @property
    def report_scope(self):
        return self.product

    def _place(self, method, args, kwargs):
        if kwargs.get("product", self.product) != self.product:
            raise ValueError("Order product differs from its execution book")
        return getattr(self.base, method)(*args, **{**kwargs, "product": self.product})

    def place_limit_order(self, *args, **kwargs):
        return self._place("place_limit_order", args, kwargs)

    def place_sl_order(self, *args, **kwargs):
        return self._place("place_sl_order", args, kwargs)

    def place_options_limit_order(self, *args, **kwargs):
        return self._place("place_options_limit_order", args, kwargs)

    def place_options_sl_order(self, *args, **kwargs):
        return self._place("place_options_sl_order", args, kwargs)

    def _rows(self, method):
        if self.base.execution_broker == "kite":
            return getattr(self.base, method)(products=(self.product,))
        rows = getattr(self.base, method)()
        if any(row.get('product_known') is False or not (row.get('product') or row.get('prod')) for row in rows):
            raise ValueError('Broker product is missing; delivery/overnight reports cannot verify this book')
        return [
            row
            for row in rows
            if str(row.get("product") or row.get("prod") or "").upper() == self.product
        ]

    def get_order_history(self):
        return self._rows("get_order_history")

    def get_trade_history(self):
        return self._rows("get_trade_history")

    def get_positions(self):
        return self._rows("get_positions")

    def get_holdings(self):
        if self.base.execution_broker == "kite":
            return self.base._read("holdings")
        return self.base._report("holdings")


def bind(broker, instrument_type):
    if instrument_type not in ("equity", "options"):
        raise ValueError("Swing supports equity and long options")
    return DeliveryBroker(broker, "CNC" if instrument_type == "equity" else "NRML")
