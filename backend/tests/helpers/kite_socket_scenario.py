"""Run in a subprocess: real Kite SDK against a local WebSocket server."""
import asyncio
import base64
import hashlib
import socket
import struct
import threading
import time
from unittest.mock import patch

from kiteconnect import KiteTicker
from app.services import kite_service as kite, market_data as market

server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen()
connections = []


def serve(connection):
    try:
        data = b""
        while b"\r\n\r\n" not in data:
            data += connection.recv(4096)
        headers = dict(line.split(": ", 1) for line in data.decode().split("\r\n")[1:] if ": " in line)
        key = next(v for k, v in headers.items() if k.lower() == "sec-websocket-key")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        connection.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                            f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        payload = struct.pack("!H", 3) + b"".join(struct.pack("!HII", 8, token, price)
                                                for token, price in [(256265, 2500000), (265, 7200000), (9999, 12345)])
        while True:
            connection.sendall(bytes([0x82, len(payload)]) + payload)
            time.sleep(.1)
    except (OSError, StopIteration):
        pass
    finally:
        connection.close()


def accept_connections():
    while True:
        connection, _ = server.accept()
        connections.append(connection)
        threading.Thread(target=serve, args=(connection,), daemon=True).start()


threading.Thread(target=accept_connections, daemon=True).start()
original = KiteTicker


def ticker_factory(api_key, access_token):
    return original(api_key, access_token, root=f"ws://127.0.0.1:{server.getsockname()[1]}")


async def scenario():
    broadcaster = kite.KiteBroadcaster()
    hub = market.MarketDataHub()
    with patch.object(kite, "get_broadcaster", return_value=broadcaster), \
         patch.object(broadcaster, "_read_config", return_value={"api_key": "dummy", "access_token": "dummy"}), \
         patch.object(kite, "fetch_options_instrument_token", return_value=9999), \
         patch("kiteconnect.KiteTicker", side_effect=ticker_factory):
        for cycle in range(2):
            web, desktop, option = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
            group = market.FeedGroup("kite", True)
            index = {"kind": "index", "symbol": "NIFTY"}
            contract = {"kind": "option", "underlying": "NIFTY", "strike": 25000, "expiry": "2026-10-06", "right": "CE"}
            handles = [await hub.subscribe(index, "website", group, web),
                       await hub.subscribe(index, "desktop", market.FeedGroup("kite"), desktop),
                       await hub.subscribe(contract, "option", group, option)]
            assert broadcaster._connected and group.connection == "connected"
            w, d, o = await asyncio.gather(*(asyncio.wait_for(q.get(), 3) for q in (web, desktop, option)))
            assert w["close"] == d["close"] == 25000
            assert (o["right"], o["strike"], o["expiry"], o["close"]) == ("CE", 25000, "2026-10-06", 123.45)
            expected_connections = 1 if cycle == 0 else 3
            assert len(connections) == expected_connections
            if cycle == 0:
                # Simulate exchange-side transport loss; the actual SDK reconnects.
                connections[-1].shutdown(socket.SHUT_RDWR)
                async def reconnected():
                    while len(connections) < 2 or not broadcaster._connected:
                        await asyncio.sleep(.05)
                await asyncio.wait_for(reconnected(), 8)
                async def next_tick(queue):
                    while True:
                        event = await queue.get()
                        if event.get("type") == "tick":
                            return event
                restored = await asyncio.wait_for(next_tick(web), 3)
                assert restored["close"] == 25000
            for handle in handles:
                handle.close()
            assert not hub.feeds and broadcaster._ticker is None
            await asyncio.sleep(.1)
    print("Kite socket scenario passed: shared delivery and stop/start on one reactor")


asyncio.run(scenario())
