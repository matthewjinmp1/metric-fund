#!/usr/bin/env python3
import ast
import json
import math
import mimetypes
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DB_PATH = Path(
    os.environ.get(
        "FINANCIALS_DB",
        "/Users/matthewjohnson/Downloads/stock_analysis/AI_stock_scorer/data/financials.db",
    )
)
START_VALUE = 100.0
APP_STARTED_AT = time.time()


DEFAULT_METRICS = [
    {"name": "ROA", "formula": "net_income / total_assets"},
    {"name": "ROE", "formula": "net_income / total_equity"},
    {"name": "FCF Margin", "formula": "fcf / revenue"},
    {"name": "Gross Margin", "formula": "gross_profit / revenue"},
    {"name": "Debt / Assets", "formula": "(st_debt + lt_debt) / total_assets"},
]


class FormulaError(ValueError):
    pass


class Formula:
    ALLOWED_BINOPS = {
        ast.Add: lambda a, b: a + b,
        ast.Sub: lambda a, b: a - b,
        ast.Mult: lambda a, b: a * b,
        ast.Div: lambda a, b: a / b if b not in (0, None) else math.nan,
        ast.Pow: lambda a, b: a**b,
        ast.Mod: lambda a, b: a % b if b not in (0, None) else math.nan,
    }
    ALLOWED_UNARY = {
        ast.UAdd: lambda a: a,
        ast.USub: lambda a: -a,
    }

    def __init__(self, expression):
        self.expression = expression.strip()
        if not self.expression:
            raise FormulaError("Formula is empty.")
        self.tree = ast.parse(self.expression, mode="eval")
        self.names = sorted({node.id for node in ast.walk(self.tree) if isinstance(node, ast.Name)})
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Load, ast.Name, ast.Constant)):
                continue
            if isinstance(node, tuple(self.ALLOWED_BINOPS.keys())):
                continue
            if isinstance(node, tuple(self.ALLOWED_UNARY.keys())):
                continue
            raise FormulaError(f"Unsupported syntax: {type(node).__name__}")

    def evaluate(self, values):
        try:
            result = self._eval(self.tree.body, values)
            return result if is_number(result) else math.nan
        except (ZeroDivisionError, OverflowError, ValueError):
            return math.nan

    def _eval(self, node, values):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return float(node.value)
            raise FormulaError("Only numeric constants are allowed.")
        if isinstance(node, ast.Name):
            return number_or_nan(values.get(node.id))
        if isinstance(node, ast.BinOp):
            fn = self.ALLOWED_BINOPS.get(type(node.op))
            if not fn:
                raise FormulaError(f"Unsupported operator: {type(node.op).__name__}")
            left = self._eval(node.left, values)
            right = self._eval(node.right, values)
            if not is_number(left) or not is_number(right):
                return math.nan
            return fn(left, right)
        if isinstance(node, ast.UnaryOp):
            fn = self.ALLOWED_UNARY.get(type(node.op))
            if not fn:
                raise FormulaError(f"Unsupported operator: {type(node.op).__name__}")
            value = self._eval(node.operand, values)
            return fn(value) if is_number(value) else math.nan
        raise FormulaError(f"Unsupported expression: {type(node).__name__}")


def is_number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def number_or_nan(value):
    if isinstance(value, bool) or value is None:
        return math.nan
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else math.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def json_safe(value):
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def get_periods(data):
    periods = data.get("period_end_date") or data.get("fiscal_quarter_key") or []
    return [str(period) for period in periods]


def get_value(data, key, index):
    value = data.get(key)
    if isinstance(value, list):
        if 0 <= index < len(value):
            return value[index]
        return math.nan
    return value


def period_values(data, index, base_keys):
    return {key: get_value(data, key, index) for key in base_keys}


def source_files():
    files = [Path(__file__).resolve()]
    if PUBLIC.exists():
        for suffix in ("*.html", "*.css", "*.js"):
            files.extend(PUBLIC.rglob(suffix))
    return sorted({path.resolve() for path in files if path.exists()})


def app_version():
    latest_mtime = max((path.stat().st_mtime for path in source_files()), default=APP_STARTED_AT)
    return f"{latest_mtime:.6f}"


def load_rows():
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Financials DB not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "select ticker, company_name, exchange, data_json from financials"
        ).fetchall()
    finally:
        conn.close()
    parsed = []
    for row in rows:
        try:
            data = json.loads(row["data_json"])
        except json.JSONDecodeError:
            continue
        parsed.append(
            {
                "ticker": row["ticker"],
                "company_name": row["company_name"],
                "exchange": row["exchange"],
                "data": data,
                "periods": get_periods(data),
            }
        )
    return parsed


def metric_catalog(limit=1):
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Financials DB not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        db_rows = conn.execute(
            "select data_json from financials order by ticker limit ?", (max(1, limit),)
        ).fetchall()
    finally:
        conn.close()
    rows = []
    for row in db_rows:
        try:
            data = json.loads(row["data_json"])
        except json.JSONDecodeError:
            continue
        rows.append({"data": data})
    keys = set()
    examples = {}
    for row in rows[: max(1, limit)]:
        data = row["data"]
        length = len(get_periods(data))
        sample_index = max(0, length - 1)
        for key, value in data.items():
            if isinstance(value, list):
                if value and any(is_number(number_or_nan(v)) for v in value):
                    keys.add(key)
                    examples.setdefault(key, get_value(data, key, sample_index))
            elif is_number(number_or_nan(value)):
                keys.add(key)
                examples.setdefault(key, value)
    return sorted(keys), examples


def compile_metrics(metrics):
    compiled = []
    for metric in metrics:
        name = str(metric.get("name", "")).strip()
        formula = str(metric.get("formula", "")).strip()
        if not name or not formula:
            continue
        compiled.append({"name": name, "formula": formula, "compiled": Formula(formula)})
    return compiled


def passes_conditions(values, conditions):
    for condition in conditions:
        metric = condition.get("metric")
        op = condition.get("operator")
        threshold = number_or_nan(condition.get("value"))
        value = number_or_nan(values.get(metric))
        if not is_number(value) or not is_number(threshold):
            return False
        if op == ">" and not value > threshold:
            return False
        if op == ">=" and not value >= threshold:
            return False
        if op == "<" and not value < threshold:
            return False
        if op == "<=" and not value <= threshold:
            return False
        if op == "==" and not value == threshold:
            return False
        if op == "!=" and not value != threshold:
            return False
    return True


def build_backtest(payload):
    user_metrics = payload.get("metrics") or DEFAULT_METRICS
    conditions = payload.get("conditions") or [{"metric": "ROA", "operator": ">", "value": 0.1}]
    max_holdings = int(payload.get("maxHoldings") or 0)
    min_revenue = float(payload.get("minRevenue") or 0)
    metrics = compile_metrics(user_metrics)
    base_keys = set()
    for metric in metrics:
        base_keys.update(metric["compiled"].names)
    base_keys.update(["period_end_price", "dividends", "market_cap", "revenue"])

    rows = load_rows()
    by_period = {}
    all_periods = set()
    excluded = {
        "price": 0,
        "revenue": 0,
        "metricCondition": 0,
    }
    for row in rows:
        data = row["data"]
        prices = data.get("period_end_price")
        if not isinstance(prices, list) or len(prices) < 2:
            continue
        dividends = data.get("dividends") if isinstance(data.get("dividends"), list) else []
        for index, period in enumerate(row["periods"][:-1]):
            price = number_or_nan(get_value(data, "period_end_price", index))
            next_price = number_or_nan(get_value(data, "period_end_price", index + 1))
            dividend = number_or_nan(dividends[index + 1] if index + 1 < len(dividends) else 0)
            all_periods.add(period)
            if not (is_number(price) and is_number(next_price)) or price <= 0 or next_price <= 0:
                excluded["price"] += 1
                continue
            revenue = number_or_nan(get_value(data, "revenue", index))
            if min_revenue and (not is_number(revenue) or revenue < min_revenue):
                excluded["revenue"] += 1
                continue
            market_cap = number_or_nan(get_value(data, "market_cap", index))
            values = period_values(data, index, base_keys)
            metric_values = {}
            for metric in metrics:
                metric_values[metric["name"]] = metric["compiled"].evaluate(values)
            if not passes_conditions(metric_values, conditions):
                excluded["metricCondition"] += 1
                continue
            total_return = ((next_price + (dividend if is_number(dividend) else 0)) / price) - 1
            if not is_number(total_return):
                continue
            by_period.setdefault(period, []).append(
                {
                    "ticker": row["ticker"],
                    "companyName": row["company_name"],
                    "exchange": row["exchange"],
                    "return": total_return,
                    "metrics": metric_values,
                    "price": price,
                    "marketCap": market_cap if is_number(market_cap) else None,
                    "revenue": revenue if is_number(revenue) else None,
                }
            )

    value = START_VALUE
    series = []
    periods = sorted(all_periods)
    for period in periods:
        holdings = by_period.get(period, [])
        if max_holdings > 0:
            sort_metric = conditions[0]["metric"] if conditions else metrics[0]["name"]
            holdings = sorted(
                holdings,
                key=lambda item: number_or_nan(item["metrics"].get(sort_metric)),
                reverse=True,
            )[:max_holdings]
        avg_return = sum(item["return"] for item in holdings) / len(holdings) if holdings else 0
        value *= 1 + avg_return
        series.append(
            {
                "period": period,
                "value": value,
                "return": avg_return,
                "holdings": len(holdings),
                "sample": holdings[:20],
            }
        )

    return {
        "dbPath": str(DB_PATH),
        "metrics": [{"name": m["name"], "formula": m["formula"]} for m in metrics],
        "conditions": conditions,
        "filters": {
            "minRevenue": min_revenue,
            "maxHoldings": max_holdings,
        },
        "startValue": START_VALUE,
        "finalValue": value if series else START_VALUE,
        "totalReturn": (value / START_VALUE - 1) if series else 0,
        "periods": len(series),
        "series": series,
        "excluded": excluded,
        "notes": [
            "Quarterly equal-weight portfolio.",
            "Signals use values at period t; returns use period_end_price t to t+1 plus next period dividend.",
            "Periods with no qualifying holdings stay in cash.",
            "No delisting, liquidity, slippage, survivorship, or filing-lag adjustments yet.",
        ],
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/metrics":
            self.send_json(self.handle_metrics())
            return
        if parsed.path == "/api/version":
            self.send_json({"version": app_version(), "startedAt": APP_STARTED_AT})
            return
        path = parsed.path.lstrip("/") or "index.html"
        self.serve_static(path)

    def do_POST(self):
        if urlparse(self.path).path != "/api/backtest":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            self.send_json(build_backtest(payload))
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=400)

    def handle_metrics(self):
        keys, examples = metric_catalog(limit=8)
        return {
            "dbPath": str(DB_PATH),
            "baseMetrics": [{"name": key, "example": examples.get(key)} for key in keys],
            "defaultMetrics": DEFAULT_METRICS,
            "defaultConditions": [{"metric": "ROA", "operator": ">", "value": 0.1}],
        }

    def serve_static(self, path):
        target = (PUBLIC / path).resolve()
        if not str(target).startswith(str(PUBLIC.resolve())) or not target.exists():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value, status=200):
        body = json.dumps(json_safe(value), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Metric fund app running at http://127.0.0.1:{port}")
    print(f"Using financials DB: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Metric fund app stopping.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
