# Regime-Adaptive cbBTC On-Chain Trading Bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/varayayyi/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/varayayyi/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

An autonomous, deterministic 1-minute bar trading engine built for the **[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444)** competition on [make.fun](https://make.fun).

---

## Strategy Architecture

Trading Coinbase Wrapped BTC (`cbBTC`) on Solana DEX pools against 1-minute OHLC bars requires overcoming round-trip execution friction (4 bps swap fee, 2 bps base slippage, and constant-product pool depth impact) while avoiding prolonged bear/choppy drawdowns.

Our engine (`RegimeMomentumEngine` in `main.ts`) implements a multi-horizon regime filter paired with asymmetric trailing risk controls:

1. **Triple-Horizon Exponential Trend Alignment**:
   - Tracks Fast (`15m`), Slow (`90m`), and Macro (`150m`) exponential moving averages alongside a 45-bar structural slope indicator on the slow trend.
   - Entries trigger only when `Price > Fast EMA > Slow EMA`, `Price > Macro EMA`, and the 45-minute slow EMA slope is expanding by at least `+5.0 bps`.
2. **Micro-Structure Volatility Guard**:
   - Evaluates the 20-minute high-low range in basis points (`computeRecentRangeBps`) to prevent chasing overextended liquidity spikes.
3. **Asymmetric Exit & Capital Preservation**:
   - **Hard Stop-Loss**: Cuts adverse excursions at `-65 bps` to keep portfolio drawdown near ~1.29% (well inside the 25% guardrail).
   - **Profit-Locked Trailing Stop**: Activates once unrealized profit exceeds `+15 bps` and trails peak close by `85 bps` to ride multi-hour expansion waves.
   - **Regime Breakdown Exit**: Liquidates position immediately if Fast EMA crosses below Slow EMA while structural slope turns negative (`< -5 bps`), followed by a 25-bar cooldown.

---

## Validated Dev-Phase Performance (`makefun grade-local`)

- **Net PnL**: `+$6.203026 USDC` (`+$4.605540 USDC` at 2x fees stress test) vs `-23.85 USDC` for Buy-and-Hold and `-35.72 to -75.56 USDC` across standard kit baselines.
- **Max Drawdown**: `1.29%` (`0.012917797`, limit `<= 25%`).
- **Determinism**: Byte-for-byte identical action logs across repeated executions (`L1 regrade reproduced byte for byte`).
