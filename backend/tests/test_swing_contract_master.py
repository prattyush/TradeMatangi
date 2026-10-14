import csv
from app.services import breeze_master as master


def test_fractional_exact_contract_and_expiry_specific_lot_from_public_master(
    tmp_path, monkeypatch
):
    path = tmp_path / "master.txt"
    rows = [
        {
            "ShortName": "NIFTY",
            "Series": "OPTION",
            "ExpiryDate": "09-Nov-2026",
            "StrikePrice": "17350.5",
            "OptionType": "CE",
            "LotSize": "65",
            "Token": "1",
        },
        {
            "ShortName": "NIFTY",
            "Series": "OPTION",
            "ExpiryDate": "09-Nov-2026",
            "StrikePrice": "17350.5",
            "OptionType": "PE",
            "LotSize": "65",
            "Token": "2",
        },
        {
            "ShortName": "NIFTY",
            "Series": "OPTION",
            "ExpiryDate": "07-Dec-2026",
            "StrikePrice": "17350.5",
            "OptionType": "CE",
            "LotSize": "75",
            "Token": "3",
        },
    ]
    with path.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    monkeypatch.setattr(
        master, "ensure_security_master_downloaded", lambda exchange: path
    )
    assert (
        master.listed_option_contract("NIFTY", 17350.5, "2026-11-09", "CE")["lot_size"]
        == 65
    )
    assert (
        master.listed_option_contract("NIFTY", 17350.5, "2026-12-07", "CE")["lot_size"]
        == 75
    )
    assert len(master.listed_option_contracts("NIFTY")) == 3
