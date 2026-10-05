"""Keep desktop history downloads out of the website's default thread pool."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from functools import partial

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="desktop-history")


async def run_history(function, /, *args, **kwargs):
    context = copy_context()
    return await asyncio.get_running_loop().run_in_executor(
        _executor, context.run, partial(function, *args, **kwargs))
