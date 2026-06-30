# Metric Fund

A local web app for building simple fundamentals-based fund backtests from a QuickFS-style financials SQLite database.

## Run

```sh
./start_server.sh
```

Then open `http://127.0.0.1:3002`.

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
- Formula metrics such as `roa` or `net_income / total_assets`
- Conditions such as `ROA > 0.10`
- A stock enters when a qualifying financial datapoint appears, contributes its next `period_end_price` plus dividend return when the next datapoint arrives, and drops out when its data ends or no longer qualifies
- The detail view shows active holdings as of each selected period
- Optional minimum revenue filter, defaulting to `$1B`

The starter ROA metric uses QuickFS's `roa` field because raw `net_income / total_assets`
uses a single quarter of net income against a balance-sheet value, which makes a `10%`
threshold far stricter than an annual ROA screen.

This is an early prototype. It does not yet handle filing lags, liquidity constraints, delistings, survivorship bias, slippage, taxes, or transaction costs.

Saved backtests are stored server-side in `data/saved_backtests.json` and can be reloaded without recalculating.
