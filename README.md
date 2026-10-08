# Polymarket v2 · paper first, live mode staged

The default workflow is a **$50 virtual-cash paper simulator** for Polymarket BTC, ETH, XRP, and SOL Up/Down 5-minute markets. Each capture uses the selected asset's public order books and trades, Polymarket opening reference, and 60-second Chainlink TWAP stream. It simulates maker orders and compares **$1 and $5** order caps, each with and without the experimental research adjustment, on the same recording. Paper commands use no wallet, private key, account endpoint, order submission, or cancellation endpoint. They cannot place a real bet.

A separate live execution path is included for later use. It shares the public market checks, feed recorder, and strategy core with paper mode, but uses exchange-confirmed order and fill reconciliation. The live launcher is **off by default** and has not been enabled or tested with real funds in v2. Paper results currently do not establish profitability.

## Start on Windows PowerShell

```powershell
git clone https://github.com/jvaragentico/polymarketv2.git
cd polymarketv2
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\scripts\start-paper-crypto.ps1 -Markets 4
```

If the repository is already on your computer, open PowerShell in that directory and begin at the `py -3 -m venv .venv` step.

The simulator selects the asset in a shuffled cycle, so each of the four assets is sampled once per four markets. The selected asset is random; the Up/Down decision is driven by the probability model and observed prices, never a coin flip. `-Markets` is the total number of market captures, not a number per asset. Use `-Assets btc,eth` to limit the selection or `-Seed 42` to reproduce an asset sequence. The simulator waits for a fresh 5-minute market, records about 90 seconds of public data, and waits up to five more minutes for an official result. A run may stop earlier if the official result is delayed; use `-Review` and resume later. It writes recordings and `runs\paper-summary.json`. Stop with `Ctrl+C`; this only stops data collection. To check pending resolutions and refresh the report later:

```powershell
.\scripts\start-paper-crypto.ps1 -Review
```

In another PowerShell window, start the local paper dashboard and open `http://127.0.0.1:8792/`:

```powershell
.\scripts\start-paper-dashboard.ps1
```

The dashboard shows rolling public-data charts, the model's TWAP, opening reference, probability, research adjustment, raw maker edge, book prices, data age, provisional simulated actions, closed paper markets, and realized virtual P&L after official resolution. Choose the $1 or $5 cap with research on or baseline at the top to compare the same market recording. It also separates paired terminal P&L from overall P&L so both-side quoting can be evaluated. It displays public CoinDesk RSS headlines and Reddit posts, with provider outages and rate limits shown. Click **Enable browser notifications** to see new simulated actions and closed-market P&L while the page is open. The dashboard has no trading controls; a separate read-only panel shows a live account session if one is deliberately started later.

Each new run records a fresh market. Four paper variants ($1/$5, research on/baseline) replay the same book and trade data. The simulator follows the market's advertised minimum share size; when it is 5 shares, a $1 order can be simulated only at prices of 20 cents or below. The $5 comparison shows how this affects opportunity count. Virtual cash rolls forward only after an identity-matched finalized market result is available. Unresolved or incomplete feed recordings are not scored as wins.

The program measures clock skew from Polymarket's public server and applies that offset to captured receive times. It polls current public order-book snapshots and records public trade and asset-specific TWAP updates. A capture with missing feeds or book snapshots arriving more than five seconds late appears under `excluded` and is never scored. A public request timeout is retried briefly; a persistent gap still excludes the run. REST snapshots between polls can miss short-lived price changes, so simulated fills remain estimates.

Public data can be delayed or time out. If capture stops, use `-Review` to inspect `excluded` and retry on a later fresh market. Failed captures do not change the virtual bankroll. No live order is ever sent.

## What the results mean

`virtual_balance` is modeled cash after finalized market payouts. `simulated_fills` are estimates based on public depth, queue position, observed aggressive trades, and latency. They are **not** exchange-confirmed fills. Public feeds can miss events; actual queue position, order acceptance, fees, cancellations, and real execution can differ. The probability model is an untrained baseline. A favorable paper result, especially from a few markets, does not establish a profitable strategy or justify refilling a live wallet. Gather a meaningful out-of-sample set of resolved markets and compare fills, trade frequency, and net results before making any live decision.

The experimental research adjustment is based only on recent asset-specific public headlines with a small, disclosed positive or negative keyword score. With two scored headlines it can change Up probability by at most one percentage point; one scored headline changes it by at most half a point. Stale, irrelevant, unavailable, or ambiguous headlines are neutral. It uses the same event and strategy core in paper and staged live modes. The dashboard shows the baseline probability and actual adjustment, and paper mode evaluates matched **research-on versus baseline** variants. Headline polarity is untrained and its predictive value for five-minute markets has not been established; it may worsen results.

## Staged live mode

The live code is present for review, but the launcher refuses real orders unless `-EnableLive` is supplied. The only recommended v2 live-path command during the paper evaluation is the read-only market preflight below. It asks for no key and places no orders:

```powershell
.\scripts\start-live-crypto.ps1 -CheckOnly
```

The real-funds path requires Node.js and `npm ci` in addition to the Python setup. It will ask for a wallet key only after the explicit live switch. Do not enable it based on a few paper results: the queue-based paper fills are estimated, while real fills, exchange failures, and P&L can differ. The live path has not undergone an end-to-end funded test in v2. Review a meaningful number of resolved paper markets, the execution implementation, and the current Polymarket rules before considering real funds. The strategy cannot guarantee profits or prevent losses.

The public [bonereaper profile](https://polymarket.com/@bonereaper) and [Polymarket Data API](https://data-api.polymarket.com/v2/docs) show trades on both outcomes in some short crypto markets. This motivates tracking paired P&L, but public trades do not reveal unfilled quotes, queue priority, incentives, or the complete trading rules. The simulator does not copy that account or count its profile P&L as evidence that this $50 strategy is profitable.


