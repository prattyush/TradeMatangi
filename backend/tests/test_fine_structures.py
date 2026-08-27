"""
Tests for fine_structure_service — CRUD definitions, flows, and search.
"""
import pytest
from unittest.mock import patch, MagicMock

from app.services.fine_structure_service import (
    list_definitions, create_definition, update_definition, delete_definition,
    list_flows, create_flow, update_flow, delete_flow,
    search_flows, _matches_subsequence, seed_predefined_definitions,
    PREDEFINED_DEFINITIONS, SYSTEM_USER,
)


FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"


def _make_mock_table():
    mock_resource = MagicMock()
    mock_table = MagicMock()
    mock_resource.Table.return_value = mock_table
    return mock_resource, mock_table


# ── Search algorithm tests ────────────────────────────────────────────────────

class TestMatchesSubsequence:
    def test_basic_match(self):
        flow = [{"name": "Opening"}, {"name": "TR"}, {"name": "Breakout"}]
        query = [{"name": "Opening"}, {"name": "TR"}]
        assert _matches_subsequence(flow, query) == 0

    def test_match_at_offset(self):
        flow = [{"name": "Opening"}, {"name": "TR"}, {"name": "Breakout"}]
        query = [{"name": "TR"}, {"name": "Breakout"}]
        assert _matches_subsequence(flow, query) == 1

    def test_no_match_non_contiguous(self):
        flow = [{"name": "Opening"}, {"name": "TR"}, {"name": "Breakout"}]
        query = [{"name": "Opening"}, {"name": "Breakout"}]
        assert _matches_subsequence(flow, query) is None

    def test_match_with_type_filter(self):
        flow = [
            {"name": "Opening"},
            {"name": "TR", "type": "narrow"},
            {"name": "Breakout"},
        ]
        query = [{"name": "TR", "type": "narrow"}]
        assert _matches_subsequence(flow, query) == 1

    def test_no_match_wrong_type(self):
        flow = [
            {"name": "Opening"},
            {"name": "TR", "type": "broad"},
            {"name": "Breakout"},
        ]
        query = [{"name": "TR", "type": "narrow"}]
        assert _matches_subsequence(flow, query) is None

    def test_match_with_direction_filter(self):
        flow = [
            {"name": "Opening"},
            {"name": "TR", "direction": "Bull"},
            {"name": "Breakout"},
        ]
        query = [{"name": "TR", "direction": "Bull"}]
        assert _matches_subsequence(flow, query) == 1

    def test_no_match_wrong_direction(self):
        flow = [
            {"name": "TR", "direction": "Bear"},
        ]
        query = [{"name": "TR", "direction": "Bull"}]
        assert _matches_subsequence(flow, query) is None

    def test_empty_query(self):
        assert _matches_subsequence([{"name": "TR"}], []) is None

    def test_empty_flow(self):
        assert _matches_subsequence([], [{"name": "TR"}]) is None

    def test_query_longer_than_flow(self):
        assert _matches_subsequence([{"name": "TR"}], [{"name": "TR"}, {"name": "Breakout"}]) is None

    def test_type_none_ignores_type(self):
        flow = [{"name": "TR", "type": "broad"}]
        query = [{"name": "TR"}]
        assert _matches_subsequence(flow, query) == 0


# ── Definitions CRUD tests ────────────────────────────────────────────────────

class TestDefinitionsCRUD:
    @patch("app.services.fine_structure_service._defs_table")
    def test_create_definition(self, mock_defs_table):
        mock_table = MagicMock()
        mock_defs_table.return_value = mock_table

        result = create_definition(FIXED_USER_ID, "My Structure", ["type_a", "type_b"])

        assert result["name"] == "My Structure"
        assert result["sub_types"] == ["type_a", "type_b"]
        assert result["is_predefined"] is False
        assert result["user_id"] == FIXED_USER_ID
        assert result["can_delete"] is True
        mock_table.put_item.assert_called_once()

    @patch("app.services.fine_structure_service._defs_table")
    def test_list_definitions_copies_predefined_on_first_access(self, mock_defs_table):
        mock_table = MagicMock()
        mock_defs_table.return_value = mock_table

        # Call sequence: seed_predefined checks system (1), _seed_user checks user (2), list queries user (3)
        mock_table.query.side_effect = [
            {"Items": [{"definition_id": "sys-exists"}]},  # seed_predefined: system defs exist, skip
            {"Items": []},  # _seed_user_definitions: user has none, triggers copy
            {"Items": [    # list_definitions: returns the copied items
                {"definition_id": "user-1", "user_id": FIXED_USER_ID, "name": "Trading Range",
                 "sub_types": ["broad"], "is_predefined": False, "created_at": "", "updated_at": ""},
                {"definition_id": "user-2", "user_id": FIXED_USER_ID, "name": "Custom",
                 "sub_types": [], "is_predefined": False, "created_at": "", "updated_at": ""},
            ]},
        ]

        import app.services.fine_structure_service as svc
        svc._seeded = False

        result = list_definitions(FIXED_USER_ID)

        names = [d["name"] for d in result]
        assert "Trading Range" in names
        assert "Custom" in names
        for d in result:
            assert d["user_id"] == FIXED_USER_ID
            assert d["can_delete"] is True

    @patch("app.services.fine_structure_service._defs_table")
    def test_delete_other_user_definition_rejected(self, mock_defs_table):
        mock_table = MagicMock()
        mock_defs_table.return_value = mock_table
        mock_table.get_item.return_value = {
            "Item": {
                "definition_id": "other-1", "user_id": "other-user", "name": "Trading Range",
                "sub_types": [], "is_predefined": False, "created_at": "", "updated_at": "",
            }
        }

        result = delete_definition(FIXED_USER_ID, "other-1")
        assert result is False

    @patch("app.services.fine_structure_service._defs_table")
    def test_update_user_definition(self, mock_defs_table):
        mock_table = MagicMock()
        mock_defs_table.return_value = mock_table
        mock_table.get_item.return_value = {
            "Item": {
                "definition_id": "user-1", "user_id": FIXED_USER_ID, "name": "Old",
                "sub_types": [], "is_predefined": False, "created_at": "", "updated_at": "",
            }
        }
        mock_table.update_item.return_value = {
            "Attributes": {
                "definition_id": "user-1", "user_id": FIXED_USER_ID, "name": "New",
                "sub_types": ["a"], "is_predefined": False, "created_at": "", "updated_at": "",
            }
        }

        result = update_definition(FIXED_USER_ID, "user-1", "New", ["a"])
        assert result is not None
        assert result["name"] == "New"


# ── Flows CRUD tests ──────────────────────────────────────────────────────────

class TestFlowsCRUD:
    @patch("app.services.fine_structure_service._flows_table")
    def test_create_flow(self, mock_flows_table):
        mock_table = MagicMock()
        mock_flows_table.return_value = mock_table

        steps = [{"definition_id": "d1", "name": "Opening"}, {"definition_id": "d2", "name": "TR"}]
        result = create_flow(FIXED_USER_ID, "NIFTY", "2024-01-15", steps)

        assert result["symbol"] == "NIFTY"
        assert result["date"] == "2024-01-15"
        assert len(result["steps"]) == 2
        assert result["can_delete"] is True
        mock_table.put_item.assert_called_once()

    @patch("app.services.fine_structure_service._flows_table")
    def test_list_flows_with_symbol_filter(self, mock_flows_table):
        mock_table = MagicMock()
        mock_flows_table.return_value = mock_table
        mock_table.query.return_value = {"Items": [
            {"flow_id": "f1", "user_id": FIXED_USER_ID, "symbol": "NIFTY", "date": "2024-01-15", "steps": []},
            {"flow_id": "f2", "user_id": FIXED_USER_ID, "symbol": "BANKNIFTY", "date": "2024-01-15", "steps": []},
        ]}

        result = list_flows(FIXED_USER_ID, symbol="NIFTY")
        assert len(result) == 1
        assert result[0]["symbol"] == "NIFTY"

    @patch("app.services.fine_structure_service._flows_table")
    def test_delete_flow_not_owner(self, mock_flows_table):
        mock_table = MagicMock()
        mock_flows_table.return_value = mock_table
        mock_table.get_item.return_value = {
            "Item": {"flow_id": "f1", "user_id": "other-user", "symbol": "NIFTY", "date": "2024-01-15", "steps": []}
        }

        result = delete_flow(FIXED_USER_ID, "f1")
        assert result is False


# ── Search tests ──────────────────────────────────────────────────────────────

class TestSearchFlows:
    @patch("app.services.fine_structure_service.list_flows")
    def test_search_finds_match(self, mock_list_flows):
        mock_list_flows.return_value = [
            {
                "flow_id": "f1", "symbol": "NIFTY", "date": "2024-01-15",
                "steps": [
                    {"name": "Opening"}, {"name": "TR"}, {"name": "Breakout"},
                ],
                "user_id": FIXED_USER_ID, "can_delete": True, "created_at": "", "updated_at": "",
            },
        ]

        results = search_flows(FIXED_USER_ID, [{"name": "Opening"}, {"name": "TR"}])
        assert len(results) == 1
        assert results[0]["match_start_index"] == 0

    @patch("app.services.fine_structure_service.list_flows")
    def test_search_no_match(self, mock_list_flows):
        mock_list_flows.return_value = [
            {
                "flow_id": "f1", "symbol": "NIFTY", "date": "2024-01-15",
                "steps": [{"name": "Opening"}, {"name": "TR"}],
                "user_id": FIXED_USER_ID, "can_delete": True, "created_at": "", "updated_at": "",
            },
        ]

        results = search_flows(FIXED_USER_ID, [{"name": "Breakout"}])
        assert len(results) == 0

    @patch("app.services.fine_structure_service.list_flows")
    def test_search_with_type_filter(self, mock_list_flows):
        mock_list_flows.return_value = [
            {
                "flow_id": "f1", "symbol": "NIFTY", "date": "2024-01-15",
                "steps": [
                    {"name": "TR", "type": "narrow"},
                    {"name": "Breakout"},
                ],
                "user_id": FIXED_USER_ID, "can_delete": True, "created_at": "", "updated_at": "",
            },
        ]

        results = search_flows(FIXED_USER_ID, [{"name": "TR", "type": "broad"}])
        assert len(results) == 0

        results = search_flows(FIXED_USER_ID, [{"name": "TR", "type": "narrow"}])
        assert len(results) == 1
