"""Destructive maintenance is tested only against Moto, never local/live DDB."""
from decimal import Decimal
import json
from unittest.mock import patch

import boto3
from boto3.dynamodb.types import TypeSerializer
import pytest
from moto import mock_aws

from app.services import ddb_maintenance as m


def wire(row):
    return {k: TypeSerializer().serialize(v) for k, v in row.items()}


def create(db, name, keys):
    return db.create_table(TableName=name,
        KeySchema=[{"AttributeName": key, "KeyType": "HASH" if i == 0 else "RANGE"} for i, (key, _) in enumerate(keys)],
        AttributeDefinitions=[{"AttributeName": key, "AttributeType": kind} for key, kind in keys],
        BillingMode="PAY_PER_REQUEST")


@pytest.fixture
def db():
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test")
        for name, keys in {
            "Sessions": [("session_id", "S")], "Trades": [("session_id", "S"), ("trade_id", "S")],
            "Orders": [("session_id", "S"), ("order_id", "S")], "Strategies": [("strategy_id", "S")],
            "TradeLabels": [("session_id", "S"), ("round_trip_index", "N")],
            "EventSnapshots": [("session_id", "S"), ("event_id", "S")],
            "AICommands": [("user_id", "S"), ("command_id", "S")],
            "AIDecisionLog": [("session_id", "S"), ("ts_command_id", "S")],
            "BrokerProtectionRecovery": [("id", "S")], "WalletLedgers": [("user_id", "S"), ("ledger_id", "S")],
        }.items():
            create(client, name, keys)
        yield client


def put(db, table, **row):
    item = wire(row)
    db.put_item(TableName=table, Item=item)
    return item


def session(db, sid="one", **extra):
    return put(db, "Sessions", session_id=sid, user_id="user", date="2026-10-15", session_type="real", **extra)


def backup_delete(db, tmp_path, selected):
    changes = m.session_inventory(db, selected)
    path = m.save_backup(db, changes, tmp_path, "test")
    backup = m.load_backup(path)
    m.delete_inventory(db, changes, backup)
    return backup


def test_delete_one_preserves_other_and_wallet_and_restores(db, tmp_path):
    selected = session(db)
    retained = session(db, "two")
    for sid in ("one", "two"):
        # Identical-looking fills are not collapsed.
        for tid in ("a", "b"):
            put(db, "Trades", session_id=sid, trade_id=tid, price=Decimal("91.30"))
    records = {
        "Orders": dict(session_id="one", order_id="order"),
        "Strategies": dict(session_id="one", strategy_id="strategy"),
        "TradeLabels": dict(session_id="one", round_trip_index=1),
        "EventSnapshots": dict(session_id="one", event_id="event"),
        "AICommands": dict(session_id="one", user_id="user", command_id="command"),
        "AIDecisionLog": dict(session_id="one", ts_command_id="ts"),
        "BrokerProtectionRecovery": dict(session_id="one", id="journal"),
    }
    for table, row in records.items():
        put(db, table, **row)
    wallet = put(db, "WalletLedgers", user_id="user", ledger_id="real-balance", balance=Decimal("999.12"), session_id="one")
    put(db, "WalletLedgers", user_id="real-observe:user", ledger_id="one", owner_user_id="user", session_id="one")
    before = {n: m.pages(db, "scan", TableName=n) for n in m.tables(db)}
    backup = backup_delete(db, tmp_path, selected)
    assert m.list_sessions(db, "user", "2026-10-15") == [retained]
    assert len(m.query(db, "Trades", "session_id", "two")) == 2
    assert m.query(db, "WalletLedgers", "user_id", "user") == [wallet]
    for table in records:
        assert not m.scan_equal(db, table, "session_id", "one")
    m.restore(db, backup)
    m.restore(db, backup)  # repeat is safe
    assert {n: m.pages(db, "scan", TableName=n) for n in m.tables(db)} == before


def test_shared_projection_rehomes_and_restores_ownership(db, tmp_path):
    root = "broker-day:shared"
    selected = session(db, broker_projection_id=root, broker_projection_owner="one")
    retained = session(db, "two", broker_projection_id=root, broker_projection_owner="one")
    manifest = put(db, "Sessions", session_id=root, owner_session_id="one", active_partition=root + ":revision")
    trade = put(db, "Trades", session_id=root + ":revision", trade_id="trade")
    put(db, "Trades", session_id=root + ":archive:one", trade_id="old")
    backup = backup_delete(db, tmp_path, selected)
    assert m.query(db, "Trades", "session_id", root + ":revision") == [trade]
    assert not m.query(db, "Trades", "session_id", root + ":archive:one")
    assert m.native(m.query(db, "Sessions", "session_id", "two")[0])["broker_projection_owner"] == "two"
    m.restore(db, backup)
    assert m.query(db, "Sessions", "session_id", root) == [manifest]
    assert m.query(db, "Sessions", "session_id", "two") == [retained]


def test_exclusive_projection_removes_all_revisions(db, tmp_path):
    root = "broker-day:exclusive"
    selected = session(db, broker_projection_id=root)
    put(db, "Sessions", session_id=root, active_partition=root + ":new")
    for partition in (root + ":old", root + ":new", root + ":archive:one"):
        put(db, "Trades", session_id=partition, trade_id="trade")
        put(db, "Orders", session_id=partition, order_id="order")
    other = put(db, "Trades", session_id="broker-day:another:new", trade_id="other")
    backup = backup_delete(db, tmp_path, selected)
    assert m.pages(db, "scan", TableName="Trades") == [other]
    assert not m.pages(db, "scan", TableName="Orders")
    m.restore(db, backup)
    assert len(m.pages(db, "scan", TableName="Trades")) == 4


def test_full_backup_restore_types_empty_tables_and_missing_table(db, tmp_path):
    row = put(db, "Trades", session_id="s", trade_id="t", decimal=Decimal("1.00001"), binary=b"abc\x00", binaries={b"x", b"y"}, numbers={Decimal("1.1"), Decimal("2")}, strings={"a", "b"}, nested={"list": [None, True, Decimal("0.01")]})
    path = m.full_backup(db, tmp_path)
    backup = m.load_backup(path)
    assert len(backup["schemas"]) == 10
    assert backup["changes"][0]["before"] == row
    db.delete_table(TableName="Trades")
    db.delete_table(TableName="Orders")  # empty table must be recreated too
    m.restore(db, backup)
    assert m.query(db, "Trades", "session_id", "s") == [row]
    assert "Orders" in m.tables(db)


def test_conflict_preflight_does_not_partially_restore(db, tmp_path):
    selected = session(db)
    put(db, "Trades", session_id="one", trade_id="t", price=10)
    backup = backup_delete(db, tmp_path, selected)
    put(db, "Trades", session_id="one", trade_id="t", price=99)
    with pytest.raises(ValueError, match="conflict"):
        m.restore(db, backup)
    assert not m.query(db, "Sessions", "session_id", "one")


def test_changed_data_after_backup_prevents_any_deletion(db, tmp_path):
    selected = session(db)
    put(db, "Trades", session_id="one", trade_id="t")
    changes = m.session_inventory(db, selected)
    path = m.save_backup(db, changes, tmp_path, "test")
    put(db, "Sessions", **{**m.native(selected), "state": "running"})
    with pytest.raises(RuntimeError, match="changed"):
        m.delete_inventory(db, changes, m.load_backup(path))
    assert m.query(db, "Trades", "session_id", "one")


def test_partial_delete_is_recoverable_and_keeps_root(db, tmp_path):
    selected = session(db)
    put(db, "Trades", session_id="one", trade_id="t")
    put(db, "Orders", session_id="one", order_id="o")
    changes = m.session_inventory(db, selected)
    backup = m.load_backup(m.save_backup(db, changes, tmp_path, "test"))
    original = db.delete_item
    def fail(**kwargs):
        if kwargs["TableName"] == "Orders":
            raise RuntimeError("storage down")
        return original(**kwargs)
    with patch.object(db, "delete_item", side_effect=fail):
        with pytest.raises(RuntimeError, match="storage down"):
            m.delete_inventory(db, changes, backup)
    assert m.query(db, "Sessions", "session_id", "one") == [selected]
    m.restore(db, backup)
    assert len(m.query(db, "Trades", "session_id", "one")) == 1


def test_backup_io_failure_and_checksum(db, tmp_path):
    selected = session(db)
    changes = m.session_inventory(db, selected)
    with patch("os.fsync", side_effect=OSError("disk full")):
        with pytest.raises(OSError):
            m.save_backup(db, changes, tmp_path, "bad")
    assert m.query(db, "Sessions", "session_id", "one") == [selected]
    path = m.save_backup(db, changes, tmp_path, "good")
    envelope = json.loads(path.read_text())
    envelope["payload"]["version"] = 99
    path.write_text(json.dumps(envelope))
    with pytest.raises(ValueError, match="checksum"):
        m.load_backup(path)


def test_pagination_including_filtered_empty_pages():
    from unittest.mock import MagicMock
    client = MagicMock()
    client.scan.side_effect = [
        {"Items": [], "LastEvaluatedKey": {"id": {"S": "first"}}},
        {"Items": [{"id": {"S": "second"}}], "LastEvaluatedKey": {"id": {"S": "second"}}},
        {"Items": [{"id": {"S": "last"}}]},
    ]
    assert len(m.pages(client, "scan", TableName="T")) == 2
    assert client.scan.call_args_list[1].kwargs["ExclusiveStartKey"] == {"id": {"S": "first"}}


def test_list_filters_user_date_and_mode(db):
    wanted = session(db)
    session(db, "swing", trading_style="swing")
    for sid, updates in (("paper", {"session_type": "paper"}), ("other-user", {"user_id": "other"}), ("other-day", {"date": "2026-10-14"})):
        put(db, "Sessions", **{**m.native(wanted), "session_id": sid, **updates})
    assert m.list_sessions(db, "user", "2026-10-15") == [wanted]


def test_target_mismatch_refused(db, tmp_path):
    backup = m.load_backup(m.full_backup(db, tmp_path))
    backup["target"]["endpoint"] = "https://different.example"
    with pytest.raises(ValueError, match="endpoint"):
        m.restore(db, backup)


def load_script(name):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[2] / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_list_only_never_prompts_or_writes(db, tmp_path, capsys):
    selected = session(db)
    module = load_script("cleanup-real-session.py")
    argv = ["cleanup-real-session.py", "--user-id", "user", "--date", "2026-10-15"]
    with patch("sys.argv", argv), patch("app.services.db.get_dynamodb_client", return_value=db), patch("builtins.input", side_effect=AssertionError("must not prompt")):
        module.main()
    assert "Read-only listing" in capsys.readouterr().out
    assert m.query(db, "Sessions", "session_id", "one") == [selected]


def test_cli_delete_and_restore_round_trip(db, tmp_path):
    selected = session(db)
    session(db, "two")
    put(db, "Trades", session_id="one", trade_id="t", timestamp=12345, price=Decimal("1.2"))
    cleanup = load_script("cleanup-real-session.py")
    argv = ["cleanup-real-session.py", "--user-id", "user", "--date", "2026-10-15", "--backend-stopped", "--backup-dir", str(tmp_path)]
    with patch("sys.argv", argv), patch("app.services.db.get_dynamodb_client", return_value=db), patch("builtins.input", return_value="delete 1"):
        cleanup.main()
    assert not m.query(db, "Sessions", "session_id", "one")
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    restore = load_script("backup-ddb.py")
    with patch("sys.argv", ["backup-ddb.py", "restore", str(files[0]), "--backend-stopped"]), patch("app.services.db.get_dynamodb_client", return_value=db), patch("builtins.input", return_value="restore"):
        restore.main()
    assert m.query(db, "Sessions", "session_id", "one") == [selected]


def test_full_backup_recreates_secondary_indexes(db, tmp_path):
    db.create_table(TableName="Indexed", KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}, {"AttributeName": "gsi", "AttributeType": "S"}, {"AttributeName": "lsi", "AttributeType": "S"}],
        GlobalSecondaryIndexes=[{"IndexName": "GlobalIndex", "KeySchema": [{"AttributeName": "gsi", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
        LocalSecondaryIndexes=[{"IndexName": "LocalIndex", "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "lsi", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "ALL"}}], BillingMode="PAY_PER_REQUEST")
    backup = m.load_backup(m.full_backup(db, tmp_path))
    db.delete_table(TableName="Indexed")
    m.restore(db, backup)
    schema = db.describe_table(TableName="Indexed")["Table"]
    assert schema["GlobalSecondaryIndexes"][0]["IndexName"] == "GlobalIndex"
    assert schema["LocalSecondaryIndexes"][0]["IndexName"] == "LocalIndex"
