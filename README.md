# Metric Fund

A local web app for building simple fundamentals-based fund backtests from a QuickFS-style financials SQLite database.

## Run

```sh
./start_server.sh
```

Then open `http://127.0.0.1:8000`.

By default the app reads:

```text
/Users/matthewjohnson/Downloads/stock_analysis/AI_stock_scorer/data/financials.db
```

Override that with:

```sh
FINANCIALS_DB=/path/to/financials.db ./start_server.sh
```

## Current Model

- Quarterly equal-weight backtest
- Formula metrics such as `net_income / total_assets`
- Conditions such as `ROA > 0.10`
- Uses `period_end_price` plus dividends for next-period returns

This is an early prototype. It does not yet handle filing lags, liquidity constraints, delistings, survivorship bias, slippage, taxes, or transaction costs.
