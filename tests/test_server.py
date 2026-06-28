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
            "minPrice": 1,
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["periods"], 2)
        self.assertEqual(result["series"][0]["period"], "2020-03")
        self.assertEqual(result["series"][0]["holdings"], 1)
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "AAA")
        self.assertAlmostEqual(result["series"][0]["return"], 0.3)
        self.assertEqual(result["series"][1]["sample"][0]["ticker"], "BBB")
        self.assertAlmostEqual(result["finalValue"], 143.0)

    def test_backtest_max_holdings_keeps_highest_condition_metric(self):
        temp, db_path = write_test_db(
            [
                {
                    "ticker": "LOW",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [20, 20],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 11],
                    },
                },
                {
                    "ticker": "HIGH",
                    "data": {
                        "period_end_date": ["2020-03", "2020-06"],
                        "net_income": [40, 40],
                        "total_assets": [100, 100],
                        "period_end_price": [10, 15],
                    },
                },
            ]
        )
        payload = {
            "metrics": [{"name": "ROA", "formula": "net_income / total_assets"}],
            "conditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
            "maxHoldings": 1,
            "minPrice": 1,
        }

        with temp, patch.object(server, "DB_PATH", db_path):
            result = server.build_backtest(payload)

        self.assertEqual(result["series"][0]["holdings"], 1)
        self.assertEqual(result["series"][0]["sample"][0]["ticker"], "HIGH")
        self.assertAlmostEqual(result["finalValue"], 150.0)


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
