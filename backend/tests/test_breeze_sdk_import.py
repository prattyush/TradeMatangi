"""A failed SDK import must not break the imports after it (seen on the server 2026-11-10: "'breeze_connect' is not a package")."""
import sys

import pytest

from app.services import breeze_history as history

INIT = "from breeze_connect.breeze_connect import BreezeConnect\n"
MODULE = '''import os, sys
sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))   # what the real SDK does
if not os.path.exists(os.environ["FAKE_SDK_READY"]):
    raise OSError("simulated security-master download failure")
class BreezeConnect:
    pass
'''


@pytest.fixture
def fake_sdk(tmp_path, monkeypatch):
    package = tmp_path / "breeze_connect"
    package.mkdir()
    (package / "__init__.py").write_text(INIT)
    (package / "breeze_connect.py").write_text(MODULE)
    ready = tmp_path / "ready"
    monkeypatch.setenv("FAKE_SDK_READY", str(ready))
    for name in [n for n in sys.modules if n == "breeze_connect" or n.startswith("breeze_connect.")]:
        monkeypatch.delitem(sys.modules, name)
    # Like the server: the package lives in site-packages, which comes after the index the SDK inserts its folder at.
    monkeypatch.setattr(sys, "path", [entry for entry in sys.path if "site-packages" not in entry] + [str(tmp_path)])
    yield ready
    for name in [n for n in sys.modules if n == "breeze_connect" or n.startswith("breeze_connect.")]:
        sys.modules.pop(name, None)


def test_the_failure_this_guards_against_is_real(fake_sdk):
    with pytest.raises(OSError):
        __import__("breeze_connect.breeze_connect")
    fake_sdk.write_text("ok")
    from breeze_connect import BreezeConnect  # seems fine...
    assert BreezeConnect is not None
    with pytest.raises(ModuleNotFoundError, match="not a package"):
        __import__("breeze_connect.breeze_connect")  # ...but the submodule import is broken


def test_a_failed_import_can_be_retried(fake_sdk):
    before = list(sys.path)
    with pytest.raises(OSError, match="simulated"):
        history.import_sdk()
    assert sys.path == before                      # the SDK's folder was taken out again
    assert "breeze_connect" not in sys.modules
    fake_sdk.write_text("ok")                      # the network is back
    sdk = history.import_sdk()
    assert hasattr(sdk, "BreezeConnect")
    assert hasattr(sys.modules["breeze_connect"], "__path__")   # the package, not the plain file
    assert history.import_sdk() is sdk              # and importing again is harmless


def test_an_already_poisoned_process_recovers(fake_sdk):
    with pytest.raises(OSError):
        __import__("breeze_connect.breeze_connect")
    fake_sdk.write_text("ok")
    from breeze_connect import BreezeConnect  # noqa: F401  (the poisoned state seen on the server)
    assert not hasattr(sys.modules["breeze_connect"], "__path__")
    sdk = history.import_sdk()
    assert hasattr(sdk, "BreezeConnect")
    assert hasattr(sys.modules["breeze_connect"], "__path__")
