# Sovereign AI — Dashboard

Live paper-trading dashboard for the Sovereign autonomous trading system. Hosted via GitHub Pages.

## Architecture

Sovereign runs two specialist AI bots that compete daily for capital allocation:

**Equity Bot** — institutional-grade swing trader focused on US equities. Evaluates sector rotation, relative strength vs SPY, technical confluence (5-factor scoring), earnings quality, and regime fit. Never trades through earnings. Operates on CHOPPY_RANGING, BEAR_HIGH_VOL, and BULL_TREND regimes.

**Crypto Bot** — on-chain quantitative crypto PM focused on Bitcoin halving cycle positioning, tier-1 accumulation, and BTC dominance dynamics. Evaluates NUPL, exchange net flows, funding rate signals, and LTH behavior. Operates on ACCUMULATION_EXTREME_FEAR, BULL_TREND, BEAR, and DISTRIBUTION regimes.

## Decision Pipeline

Every proposed trade flows through this pipeline before capital is deployed:

```
Nightly Screener (500+ equities, 10+ crypto)
    ↓  Top 15 candidates by RS + confluence
AI Analysis (9 AM ET / 3 PM ET cron)
    ↓  Regime-appropriate playbook applied
The Tribunal — 4-judge panel
    ├─ Bear Judge (Opus, hard-veto authority — score <35 = instant ABORT)
    ├─ Quant Judge (technical merit, signal independence, EV calculation)
    ├─ Risk Judge (portfolio heat, sector concentration, Kelly sizing)
    └─ Regime Judge (cycle fit, historical edge for this setup type)
    ↓  Weighted vote — accurate judges earn higher weight over time
Execution (Alpaca paper trading)
    ↓
29-Step Nightly Learning Loop
    ↓  Grades decisions, updates weights, recalibrates signals
```

## The Commissioner

A meta-intelligence layer that monitors both bots continuously. Dynamically adjusts capital allocation split (equity vs crypto) based on live performance metrics. Can operate in DUAL mode (both bots active), EQUITY_ONLY, or CRYPTO_ONLY. The Commissioner ensures capital flows toward the bot with current edge.

## The Tribunal

All equity and crypto buy decisions go through the same 4-judge panel. Each judge builds a live accuracy record — judges whose verdicts historically correlate with winning trades earn higher vote weight (dynamic weight calibration via nightly `tribunal_backfiller.py`). Bear judge runs first with hard-veto authority regardless of other judges' scores.

**Devil's Advocate is retired.** The Tribunal supersedes DA for all asset classes with a more rigorous, multi-dimensional review.

## Data Pipeline

Dashboard data is embedded directly into the HTML at push time (`push_dashboard_data.py`). No runtime API calls for core data — renders instantly. Live crypto prices fetched from CoinGecko at page load. Live equity prices fetched via yfinance at push time.

## Cron Schedule

| Time (ET) | Job |
|---|---|
| 4:30 PM weekdays | Screen — build nightly watchlist |
| 9:00 AM weekdays | Analyze — morning decision cycle |
| 2:30 PM weekdays | Check — position management |
| 3:00 PM weekdays | 3PM Scan — institutional positioning window |
| Nightly ~11 PM | Learning loop — 29-step grading and recalibration |

## Status

Paper trading active. 90-day paper trading requirement before live capital deployment. See live readiness gate progress on the dashboard.

---
*Not financial advice. Sovereign is an experimental autonomous trading system.*
