import * as readline from "node:readline";

interface BarItem {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  o_depth?: string[];
  c_depth?: string[];
}

interface PositionItem {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface AccountState {
  cash_quote_units: string;
  positions: PositionItem[];
  equity_quote_units: string;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  t: number;
  bars: BarItem[];
  account: AccountState;
}

interface OrderOut {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
}

class RegimeMomentumEngine {
  private readonly targetSymbol = "CBBTC";
  private readonly fastPeriod = 15;
  private readonly slowPeriod = 90;
  private readonly macroPeriod = 150;
  private readonly slopeLookback = 45;

  private readonly minSlopeBps = 5.0;
  private readonly hardStopBps = 65.0;
  private readonly trailingStopBps = 85.0;
  private readonly takeProfitBps = 320.0;
  private readonly cooldownBars = 25;
  private readonly maxVolatilityBps = 220.0;

  private closes: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private emaFast: number[] = [];
  private emaSlow: number[] = [];
  private emaMacro: number[] = [];

  private entryPrice = 0;
  private peakPrice = 0;
  private cooldownRemaining = 0;
  private orderCounter = 0;

  private updateEma(series: number[], price: number, period: number): number {
    if (series.length === 0) {
      series.push(price);
      return price;
    }
    const alpha = 2.0 / (period + 1.0);
    const prev = series[series.length - 1];
    const nextVal = alpha * price + (1.0 - alpha) * prev;
    series.push(nextVal);
    return nextVal;
  }

  private computeRecentRangeBps(windowBars: number): number {
    const n = this.closes.length;
    const start = Math.max(0, n - windowBars);
    let hi = this.highs[start];
    let lo = this.lows[start];
    for (let i = start + 1; i < n; i++) {
      if (this.highs[i] > hi) hi = this.highs[i];
      if (this.lows[i] < lo) lo = this.lows[i];
    }
    return lo > 0 ? ((hi - lo) / lo) * 10000.0 : 0.0;
  }

  public onBatch(msg: BatchMsg): OrderOut[] {
    const bar = msg.bars.find((b) => b.symbol === this.targetSymbol);
    if (!bar) {
      return [];
    }

    const closePrice = Number(bar.c);
    const highPrice = Number(bar.h);
    const lowPrice = Number(bar.l);

    this.closes.push(closePrice);
    this.highs.push(highPrice);
    this.lows.push(lowPrice);

    const ef = this.updateEma(this.emaFast, closePrice, this.fastPeriod);
    const es = this.updateEma(this.emaSlow, closePrice, this.slowPeriod);
    const em = this.updateEma(this.emaMacro, closePrice, this.macroPeriod);

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining -= 1;
    }

    const n = this.closes.length;
    const minWarmup = Math.max(this.slowPeriod, this.macroPeriod) + this.slopeLookback;
    if (n <= minWarmup) {
      return [];
    }

    const prevSlow = this.emaSlow[n - 1 - this.slopeLookback];
    const slopeBps = ((es - prevSlow) / prevSlow) * 10000.0;
    const recentRangeBps = this.computeRecentRangeBps(20);

    const currentPos = msg.account.positions.find((p) => p.symbol === this.targetSymbol);
    const posQtyBig = currentPos ? BigInt(currentPos.qty) : 0n;
    const hasPosition = posQtyBig > 0n;

    const orders: OrderOut[] = [];

    if (!hasPosition) {
      this.entryPrice = 0;
      this.peakPrice = 0;

      const trendAligned = ef > es && closePrice > em && closePrice > ef;
      const momentumExpanding = slopeBps >= this.minSlopeBps;
      const volatilityHealthy = recentRangeBps <= this.maxVolatilityBps;

      if (this.cooldownRemaining === 0 && trendAligned && momentumExpanding && volatilityHealthy) {
        const cashBig = BigInt(msg.account.cash_quote_units);
        const deployBig = (cashBig * 992n) / 1000n;
        if (deployBig >= 10000000n) {
          this.orderCounter += 1;
          this.entryPrice = closePrice;
          this.peakPrice = closePrice;
          orders.push({
            side: "buy",
            client_id: `entry-${msg.seq}-${this.orderCounter}`,
            symbol: this.targetSymbol,
            notional_quote_units: deployBig.toString(),
            max_slippage_bps: 150,
          });
        }
      }
    } else {
      if (this.entryPrice <= 0) {
        this.entryPrice = closePrice;
      }
      if (closePrice > this.peakPrice) {
        this.peakPrice = closePrice;
      }

      const unrealizedBps = ((closePrice - this.entryPrice) / this.entryPrice) * 10000.0;
      const drawdownFromPeakBps =
        this.peakPrice > 0 ? ((this.peakPrice - closePrice) / this.peakPrice) * 10000.0 : 0.0;

      const hitHardStop = unrealizedBps <= -this.hardStopBps;
      const hitTrailingStop = drawdownFromPeakBps >= this.trailingStopBps && unrealizedBps > 15.0;
      const hitTakeProfit = unrealizedBps >= this.takeProfitBps;
      const regimeBroken = ef < es && slopeBps < -5.0;

      if (hitHardStop || hitTrailingStop || hitTakeProfit || regimeBroken) {
        this.orderCounter += 1;
        this.cooldownRemaining = this.cooldownBars;
        this.entryPrice = 0;
        this.peakPrice = 0;
        orders.push({
          side: "sell",
          client_id: `exit-${msg.seq}-${this.orderCounter}`,
          symbol: this.targetSymbol,
          qty: posQtyBig.toString(),
          max_slippage_bps: 200,
        });
      }
    }

    return orders;
  }
}

function runBot(): void {
  const engine = new RegimeMomentumEngine();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const msg = JSON.parse(trimmed);
    if (msg.type === "batch") {
      const orders = engine.onBatch(msg as BatchMsg);
      const reply = {
        type: "reply",
        seq: msg.seq,
        orders,
      };
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  });
}

runBot();
