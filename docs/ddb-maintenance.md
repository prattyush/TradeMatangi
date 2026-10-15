# DynamoDB backup and Real session cleanup

Run from the repository root using the backend Python environment. Both scripts
use the backend database configuration (`USE_DYNAMODB_LOCAL`, endpoint, region
and credentials). They print the destination before operating. Stop **all backend
instances** using that database before backup, deletion or restoration and keep
them stopped until verification finishes. `--backend-stopped` records your
confirmation; the scripts cannot detect servers running on another machine.

## Back up the entire database

```bash
source ~/venvs/tradematangi/bin/activate
python scripts/backup-ddb.py backup --backend-stopped
```

The script reads every page of every table and saves one verified, timestamped
JSON file under `data/backups/` (gitignored). Use `--backup-dir /safe/path` to choose
another directory. Files contain sensitive trading/account data; keep them private
and copy the backup off the server for protection against disk/server failure.
Backups preserve DynamoDB numbers, binary values, sets, nested values and table key
and index definitions, including empty tables. This is an offline records backup,
not an AWS point-in-time backup; TTL settings, streams, autoscaling, policies and
other operational table settings are not included.

## Inspect and delete one duplicate Real Day session

First make the full backup above. Then:

```bash
python scripts/cleanup-real-session.py --user-id USER_ID --date 2026-10-15
python scripts/cleanup-real-session.py --user-id USER_ID --date 2026-10-15 --backend-stopped
```

The first command only lists sessions, trades and orders. The second lists them
again and accepts `delete 1` (or another displayed number). Press Enter to cancel.
Session numbering is local to that listing; check the full IDs and trades. Nothing
is automatically selected or deduplicated. Separate fills with identical displayed
prices/times remain separate.

Deletion creates and verifies a mandatory session backup first, then deletes that
session's trades, orders, strategies, labels, snapshots and AI records, plus its
protection recovery and administrative heartbeat records. Exclusive broker
projection revisions/archives are included. Shared projections remain available;
if needed, their ownership moves to a retained referencing session, and original
records are backed up. The selected session root is deleted last. Wallet balances,
shared fee adjustments, other sessions and broker orders are preserved. No broker
API is called. Runtime/UI caches clear when the backend is restarted.

Maintenance may scan session metadata and tables lacking a session primary key.
Exclusive projection revisions also require a filtered scan because DynamoDB
cannot query a hash-key prefix. This happens only in the offline tool, never in
trading request paths. Large databases require memory/disk space for the selected
records (or all records for a full backup).

## Restore either backup

```bash
python scripts/backup-ddb.py restore data/backups/BACKUP_FILE.json --backend-stopped
```

Check the printed destination/counts, then type `restore`. The checksum and target
endpoint/region and existing table ARNs are checked first. Missing tables are recreated with their
key/index definitions and on-demand billing. Missing records are restored; already
restored identical records are accepted. For cleanup backups, ownership changes
are reversed only if the current record still matches the backed-up change.
Conflicting records cause an error before any records are written. Full restore
restores records; it does **not** wipe the database or remove extra records. To
recover deleted data, restore before restarting trading or changing account data.

If deletion or restore fails, the command exits unsuccessfully. Keep the backend
stopped and restore/retry using the printed backup. A partial restore is safe to
retry. Backup files are never deleted automatically.
