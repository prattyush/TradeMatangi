"""Keep desktop history downloads out of the website's default thread pool."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar, copy_context
from contextlib import contextmanager
from functools import partial

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="desktop-history")


async def run_history(function, /, *args, **kwargs):
    context = copy_context()
    return await asyncio.get_running_loop().run_in_executor(
        _executor, context.run, partial(function, *args, **kwargs))


_desktop_scope = ContextVar('desktop_history_worker', default=False)

@contextmanager
def desktop_history_scope():
    token = _desktop_scope.set(True)
    try:
        yield
    finally:
        _desktop_scope.reset(token)

async def run_data_history(function, /, *args, **kwargs):
    """Website keeps its executor; desktop adapters share the bounded history pool."""
    if _desktop_scope.get():
        return await run_history(function, *args, **kwargs)
    return await asyncio.to_thread(function, *args, **kwargs)
