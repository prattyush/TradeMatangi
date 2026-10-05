"""Own Twisted startup once; marshal every Kite socket operation to its thread."""
from concurrent.futures import Future
import threading

_start_lock = threading.Lock()


def call(function, *args):
    from twisted.internet import reactor
    from twisted.python.threadable import isInIOThread
    if isInIOThread():
        return function(*args)
    with _start_lock:
        if not reactor.running:
            ready = threading.Event()
            reactor.callWhenRunning(ready.set)
            thread = threading.Thread(target=reactor.run, kwargs={"installSignalHandlers": False},
                                      name="kite-reactor", daemon=True)
            thread.start()
            if not ready.wait(5):
                raise RuntimeError("Kite reactor did not start")
    result = Future()
    def invoke():
        if not result.set_running_or_notify_cancel():
            return
        try:
            result.set_result(function(*args))
        except BaseException as exc:
            result.set_exception(exc)
    reactor.callFromThread(invoke)
    try:
        return result.result(timeout=5)
    except TimeoutError:
        result.cancel()
        raise RuntimeError("Kite reactor operation timed out") from None
