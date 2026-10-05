"""Exercise installer orchestration without modifying test-runner packages."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts/install-backend-dependencies.sh"


@pytest.fixture
def environment(tmp_path):
    venv = tmp_path / "venv with spaces"
    (venv / "bin").mkdir(parents=True)
    executable = venv / "bin/python"
    executable.write_text(f"#!{sys.executable}\n" + '''
import json, os, sys
with open(os.environ["CALL_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] == ["-"]:
    source = sys.stdin.read()
    if "sys.version_info" in source:
        if os.environ.get("INCOMPATIBLE"):
            raise SystemExit("Python 3.10+ required")
        print("yes" if os.environ.get("LEGACY") else "no")
    elif os.environ.get("BAD_IMPORT"):
        raise SystemExit("SDK verification failed")
elif os.environ.get("FAIL_PIP") == " ".join(sys.argv[3:4]):
    raise SystemExit("pip failed")
''')
    executable.chmod(0o755)
    env = {**os.environ, "CALL_LOG": str(tmp_path / "calls.jsonl")}
    def run(**options):
        result = subprocess.run(["bash", str(INSTALLER), "--venv", str(venv)],
                                env={**env, **options}, capture_output=True, text=True)
        calls = [json.loads(line) for line in Path(env["CALL_LOG"]).read_text().splitlines()]
        return result, calls
    return run, venv, env


@pytest.mark.parametrize("legacy", [False, True])
def test_healthy_and_legacy_or_mixed_environments(environment, legacy):
    run, _, _ = environment
    result, calls = run(**({"LEGACY": "yes"} if legacy else {}))
    assert result.returncode == 0, result.stderr
    pip_calls = [c for c in calls if c[:2] == ["-m", "pip"]]
    if legacy:
        assert pip_calls[0] == ["-m", "pip", "uninstall", "-y", "neo-api-client", "kotakneoapi"]
    else:
        assert all("uninstall" not in c for c in pip_calls)
    assert pip_calls[-2] == ["-m", "pip", "install", "-r", str(ROOT / "backend/requirements.txt")]
    assert pip_calls[-1] == ["-m", "pip", "check"]


@pytest.mark.parametrize("failure,options", [
    ("uninstall", {"LEGACY": "yes", "FAIL_PIP": "uninstall"}),
    ("install", {"FAIL_PIP": "install"}),
    ("check", {"FAIL_PIP": "check"}),
    ("version", {"INCOMPATIBLE": "yes"}),
    ("imports", {"BAD_IMPORT": "yes"}),
])
def test_failures_abort_without_later_steps(environment, failure, options):
    run, _, _ = environment
    result, calls = run(**options)
    assert result.returncode != 0
    assert "Backend dependencies verified" not in result.stdout
    if failure in ("uninstall", "version"):
        assert not any(c[:3] == ["-m", "pip", "install"] for c in calls)
    if failure in ("install", "imports"):
        assert not any(c == ["-m", "pip", "check"] for c in calls)


def test_default_home_path(environment, tmp_path):
    _, venv, env = environment
    home_venv = tmp_path / "home/venvs/tradematangi"
    home_venv.parent.mkdir(parents=True)
    home_venv.symlink_to(venv, target_is_directory=True)
    result = subprocess.run(["bash", str(INSTALLER)], env={**env, "HOME": str(tmp_path / "home")},
                            capture_output=True, text=True)
    assert result.returncode == 0


@pytest.mark.parametrize("arguments", [["--venv", "/does/not/exist"], ["--bad"], ["--venv"]])
def test_missing_venv_and_invalid_arguments_fail(arguments):
    result = subprocess.run(["bash", str(INSTALLER), *arguments], capture_output=True, text=True)
    assert result.returncode != 0


@pytest.mark.parametrize("script", ["start-backend.sh", "start-backend-ec2.sh"])
def test_startup_aborts_when_shared_installer_fails(environment, tmp_path, script):
    _, venv, env = environment
    home = tmp_path / "home"
    default = home / "venvs/tradematangi"
    default.parent.mkdir(parents=True)
    default.symlink_to(venv, target_is_directory=True)
    # EC2 interpreter discovery and version comparison are simulated too.
    version_python = tmp_path / "python3.13"
    version_python.write_text('#!/usr/bin/env bash\necho "3.12"\n')
    version_python.chmod(0o755)
    fake_python = venv / "bin/python"
    source = fake_python.read_text().replace('if sys.argv[1:] == ["-"]:',
        'if sys.argv[1:2] == ["-c"]:\n    print("3.12")\n    raise SystemExit(0)\nif sys.argv[1:] == ["-"]:')
    fake_python.write_text(source)
    result = subprocess.run(["bash", str(ROOT / "scripts" / script)],
                            env={**env, "HOME": str(home), "PATH": str(tmp_path) + ":" + env["PATH"],
                                 "FAIL_PIP": "install"}, capture_output=True, text=True)
    assert result.returncode != 0
    assert "pip failed" in result.stderr
    assert "Starting backend" not in result.stdout


def test_target_release_is_pinned_and_startups_do_not_install_legacy():
    assert "kotakneoapi==3.0.7" in (ROOT / "backend/requirements.txt").read_text().splitlines()
    for name in ("start-backend.sh", "start-backend-ec2.sh"):
        text = (ROOT / "scripts" / name).read_text()
        assert "install-backend-dependencies.sh" in text
        assert "Kotak-neo-api-v2" not in text
