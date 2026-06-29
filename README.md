# Metric Fund

A local web app for building simple fundamentals-based fund backtests from a QuickFS-style financials SQLite database.

## Run

```sh
./start_server.sh
```

Then open `http://127.0.0.1:8000`.

The dev server auto-restarts when Python or public web files change, and the browser refreshes itself after source changes. To run without auto-reload:

```sh
AUTO_RELOAD=0 ./start_server.sh
```

By default the app reads:

```text
/Users/matthewjohnson/Downloads/stock_analysis/AI_stock_scorer/data/financials.db
```

Override that with:

```sh
FINANCIALS_DB=/path/to/financials.db ./start_server.sh
```

## Current Model

- Rolling equal-weight completed-interval backtest
- Formula metrics such as `net_income / total_assets`
- Conditions such as `ROA > 0.10`
- A stock enters when a qualifying financial datapoint appears, contributes its next `period_end_price` plus dividend return when the next datapoint arrives, and drops out when its data ends or no longer qualifies
- Optional minimum revenue filter, defaulting to `$1B`

This is an early prototype. It does not yet handle filing lags, liquidity constraints, delistings, survivorship bias, slippage, taxes, or transaction costs.
