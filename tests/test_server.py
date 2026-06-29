import json
import math
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server


def write_test_db(rows):
    temp = tempfile.TemporaryDirectory()
    path = Path(temp.name) / "financials.db"
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            create table financials (
                ticker text primary key,
                company_name text,
                exchange text,
                data_json text,
                updated_at text
            )
            """
        )
        conn.executemany(
            "insert into financials values (?, ?, ?, ?, ?)",
            [
                (
                    row["ticker"],
                    row.get("company_name", row["ticker"]),
                    row.get("exchange", "NYSE"),
                    json.dumps(row["data"]),
                    "2026-01-01T00:00:00",
                )
                for row in rows
            ],
        )
        conn.commit()
    finally:
        conn.close()
    return temp, path


class FormulaTests(unittest.TestCase):
    def test_formula_evaluates_arithmetic_and_names(self):
        formula = server.Formula("(net_income / total_assets) * 100")

        self.assertEqual(formula.names, ["net_income", "total_assets"])
        self.assertAlmostEqual(
            formula.evaluate({"net_income": 25, "total_assets": 200}),
            12.5,
        )

    def test_formula_rejects_calls_and_attributes(self):
        with self.assertRaises(server.FormulaError):
            server.Formula("__import__('os').system('echo nope')")

        with self.assertRaises(server.FormulaError):
            server.Formula("net_income.real")

    def test_formula_returns_nan_for_missing_values_and_zero_division(self):
        self.assertTrue(math.isnan(server.Formula("net_income / total_assets").evaluate({"net_income": 3})))
        self.assertTrue(
            math.isnan(
                server.Formula("net_income / total_assets").evaluate(
                    {"net_income": 3, "total_assets": 0}
                )
            )
        )

    def test_json_safe_replaces_non_finite_numbers(self):
        cleaned = server.json_safe(
            {
                "valid": 1.2,
                "bad": math.nan,
                "nested": [math.inf, -math.inf, {"ok": 3}],
            }
        )

        self.assertEqual(
            cleaned,
            {"valid": 1.2, "bad": None, "nested": [None, None, {"ok": 3}]},
        )
        self.assertNotIn("NaN", json.dumps(cleaned, allow_nan=False))


class BacktestTests(unittest.TestCase):
    def test_metric_catalog_reads_numeric_fields_from_sample_rows(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "AAA",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [10, 12],
                        "total_assets": [100, 110],
                        "period_end_price": [10, 12],
                        "company_label": ["A", "B"],
                    },
                }
            ]
        )
        with temp, patch.object(server, "DB_PATH", db_path):
            keys, examples = server.metric_catalog(limit=1)

        self.assertIn("net_income", keys)
        self.assertIn("period_end_price", keys)
        self.assertNotIn("company_label", keys)
        self.assertEqual(examples["net_income"], 12)

    def test_backtest_filters_conditions_and_uses_dividend_adjusted_return(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "AAA",
                    "company_name": "Alpha",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06", "2020-09"],
                        "net_income": [12, 9, 5],
                        "total_assets": [100, 100, 100],
                        "period_end_price": [10, 12, 9],
                        "dividends": [0, 1, 0],
                    },
                },
                {
                    "ticker": "BBB",
                    "company_name": "Beta",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06", "2020-09"],
                        "net_income": [4, 20, 20],
                        "total_assets": [100, 100, 100],
                        "period_end_price": [10, 20, 22],
                        "dividends": [0, 0, 0],
                    },
                },
            ]
        )
        payload = {
            "metrics": [{"name": "ROA", "formula": "net_income / total_assets"}],
            "conditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["periods"], 3)
        self.assertEqual(result["series"][0]["period"], "2020-03")
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "AAA")
        self.assertEqual(result["series"][0]["completed"], 0)
        self.assertEqual(result["series"][1]["period"], "2020-06")
        self.assertEqual(result["series"][1]["completed"], 1)
        self.assertEqual(result["series"][1]["completedSample"][0]["ticker"], "AAA")
        self.assertEqual(result["series"][1]["completedSample"][0]["startPeriod"], "2020-03")
        self.assertEqual(result["series"][1]["completedSample"][0]["endPeriod"], "2020-06")
        self.assertAlmostEqual(result["series"][1]["return"], 0.3)
        self.assertEqual(result["series"][2]["completedSample"][0]["ticker"], "BBB")
        self.assertEqual(result["series"][2]["period"], "2020-09")
        self.assertAlmostEqual(result["finalValue"], 143.0)

    def test_default_roa_uses_quickfs_ratio_instead_of_quarterly_income_over_assets(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "RATIO",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "roa": [0.2, 0.2],
                        "roe": [0.3, 0.3],
                        "fcf_margin": [0.1, 0.1],
                        "gross_margin": [0.5, 0.5],
                        "debt_to_assets": [0.2, 0.2],
                        "net_income": [5, 5],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 11],
                        "revenue": [1_000_000_000, 1_100_000_000],
                    },
                }
            ]
        )
        payload = {"minRevenue": 1_000_000_000}

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["metrics"][0], {"name": "ROA", "formula": "roa"})
        self.assertEqual(result["series"][0]["holdings"], 1)
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "RATIO")
        self.assertAlmostEqual(result["finalValue"], 110)

    def test_backtest_rolls_staggered_company_dates_independently(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "MAR",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [20, 20],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 11],
                    },
                },
                {
                    "ticker": "APR",
                    "data": {
                        "period_end_date": ["2020-04", "2020-07"],
                        "net_income": [30, 30],
                        "total_assets": [100, 100],
                        "period_end_price": [20, 22],
                    },
                },
            ]
        )
        payload = {
            "metrics": [{"name": "ROA", "formula": "net_income / total_assets"}],
            "conditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual([point["period"] for point in result["series"]], ["2020-03", "2020-04", "2020-06", "2020-07"])
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "MAR")
        self.assertEqual({row["ticker"] for row in result["series"][1]["sample"]}, {"MAR", "APR"})
        self.assertEqual(result["series"][2]["completedSample"][0]["ticker"], "MAR")
        self.assertEqual(result["series"][3]["completedSample"][0]["ticker"], "APR")
        self.assertAlmostEqual(result["finalValue"], 121.0)

    def test_backtest_series_shows_active_holdings_snapshot(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "OLD",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [20, 20],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 11],
                    },
                },
                {
                    "ticker": "ACTIVE",
                    "data": {
                        "period_end_date": ["2020-06", "2020-09"],
                        "net_income": [30, 30],
                        "total_assets": [100, 100],
                        "period_end_price": [20, 22],
                    },
                },
            ]
        )
        payload = {
            "metrics": [{"name": "ROA", "formula": "net_income / total_assets"}],
            "conditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["series"][0]["period"], "2020-03")
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "OLD")
        self.assertEqual(result["series"][1]["period"], "2020-06")
        self.assertEqual(result["series"][1]["completedSample"][0]["ticker"], "OLD")
        self.assertEqual(result["series"][1]["sample"][0]["ticker"], "ACTIVE")
        self.assertEqual(result["series"][1]["holdings"], 1)

    def test_backtest_applies_minimum_revenue_filter(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "SMALLREV",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [50, 50],
                        "total_assets": [100, 100],
                        "period_end_price": [1, 10],
                        "revenue": [100_000_000, 120_000_000],
                    },
                },
                {
                    "ticker": "LARGE",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [20, 20],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 11],
                        "revenue": [1_000_000_000, 1_100_000_000],
                    },
                },
            ]
        )
        payload = {
            "metrics": [{"name": "ROA", "formula": "net_income / total_assets"}],
            "conditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
            "minRevenue": 1_000_000_000,
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["series"][0]["holdings"], 1)
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "LARGE")
        self.assertAlmostEqual(result["finalValue"], 110)
        self.assertEqual(result["excluded"]["revenue"], 1)

class VersionTests(unittest.TestCase):
    def test_app_version_reflects_latest_source_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            public = Path(tmp) / "public"
            public.mkdir()
            server_file = Path(tmp) / "server.py"
            script_file = public / "script.js"
            server_file.write_text("print('server')\n")
            script_file.write_text("console.log('v1');\n")
            now = time.time()
            older = now - 10
            newer = now - 2
            with patch.object(server, "__file__", str(server_file)), patch.object(server, "PUBLIC", public):
                os.utime(server_file, (older, older))
                os.utime(script_file, (newer, newer))
                self.assertEqual(server.app_version(), f"{newer:.6f}")


if __name__ == "__main__":
    unittest.main()
