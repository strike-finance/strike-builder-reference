import { useState, useEffect, useMemo } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { useMarkets } from "./hooks/useMarkets";
import { usePriceStream } from "./hooks/usePriceStream";
import { useUserStream } from "./hooks/useUserStream";
import { useEnrichedPositions } from "./hooks/usePositions";
import { calculateBalances, calculateOpenOrderCosts } from "./math/balanceCalculations";
import type { SupportedChain } from "./api/wallets";
import type { ConnectedInfo } from "./components/ConnectPanel";

import { ConnectPanel } from "./components/ConnectPanel";
import { MarketSelector } from "./components/MarketSelector";
import { PriceBar } from "./components/PriceBar";
import { OrderBook } from "./components/OrderBook";
import { OrderForm } from "./components/OrderForm";
import { PositionsTable } from "./components/PositionsTable";
import { AccountPanel } from "./components/AccountPanel";
import { DepositPanel } from "./components/DepositPanel";
import { WithdrawPanel } from "./components/WithdrawPanel";
import { Chart } from "./components/Chart";

export default function App() {
  // All auth state in memory — no localStorage
  const [connectedInfo, setConnectedInfo] = useState<ConnectedInfo | null>(null);
  const accountId = connectedInfo?.accountId ?? null;
  const chain = connectedInfo?.chain ?? "cardano";

  // Listen for session expired (401 from API wallet auth)
  useEffect(() => {
    const handler = () => {
      console.log("[App] Session expired — resetting to connect screen");
      setConnectedInfo(null);
    };
    window.addEventListener("strike:session-expired", handler);
    return () => window.removeEventListener("strike:session-expired", handler);
  }, []);

  // Market data
  const { markets, symbols } = useMarkets();
  const [symbol, setSymbol] = useState("ADA-USD");

  // Real-time price stream
  const { prices, markPrice, indexPrice, fundingRate, nextFundingTime, depth } =
    usePriceStream(symbol);

  // User data stream: REST fetch on connect, then WS updates
  const { positions, orders, walletBalance, account } = useUserStream(accountId);

  // Enrich positions with derived fields (PnL, liquidation, etc.)
  // Pass account for leverage fallback (WS doesn't send leverage)
  const enrichedPositions = useEnrichedPositions(
    positions,
    prices,
    markets,
    walletBalance,
    account
  );

  // Open order costs — margin locked by open orders (matches Strike app netting formula)
  const openOrderCosts = useMemo(() =>
    calculateOpenOrderCosts(orders, positions, prices, account?.symbol_settings, markets),
    [orders, positions, prices, account?.symbol_settings, markets]
  );

  // Calculate balances with open order costs factored in
  const balances = useMemo(() => {
    const calculated = calculateBalances(walletBalance, enrichedPositions, openOrderCosts);
    if (account) {
      const serverAvailable = parseFloat(account.available_balance || "0");
      const serverWithdrawable = parseFloat(account.withdrawable_balance || "0");
      const serverMarginBalance = parseFloat(account.margin_balance || "0");
      return {
        ...calculated,
        availableBalance: serverAvailable || calculated.availableBalance,
        withdrawableBalance: serverWithdrawable || calculated.withdrawableBalance,
        marginBalance: serverMarginBalance || calculated.marginBalance,
      };
    }
    return calculated;
  }, [walletBalance, enrichedPositions, openOrderCosts, account]);

  const currentMarket = markets[symbol] ?? null;
  const basePrec = currentMarket?.base_prec ?? 4;

  return (
    <div className="app">
      <ToastContainer
        position="top-right"
        autoClose={4000}
        theme="dark"
        toastStyle={{ background: "#1a1a1a", color: "#fff", fontSize: 13 }}
      />
      <header className="app-header">
        <h1>Strike Builder Reference</h1>
        <MarketSelector
          symbols={symbols.length > 0 ? symbols : ["ADA-USD"]}
          selected={symbol}
          onChange={setSymbol}
        />
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <ConnectPanel
            connectedInfo={connectedInfo}
            onConnected={setConnectedInfo}
            onDisconnected={() => setConnectedInfo(null)}
          />

          {accountId && (
            <>
              <AccountPanel
                walletBalance={walletBalance}
                availableBalance={balances.availableBalance}
                marginBalance={balances.marginBalance}
                positionValue={balances.positionValue}
                totalUnrealizedPnL={balances.totalUnrealizedPnL}
              />
              <DepositPanel accountId={accountId} chain={chain} />
              <WithdrawPanel
                chain={chain}
                withdrawableBalance={balances.withdrawableBalance}
              />
            </>
          )}
        </aside>

        <main className="main-content">
          <PriceBar
            symbol={symbol}
            markPrice={markPrice}
            indexPrice={indexPrice}
            fundingRate={fundingRate}
            nextFundingTime={nextFundingTime}
          />

          <Chart symbol={symbol} markPrice={markPrice} />

          <div className="trading-grid">
            <OrderBook
              depth={depth}
              midPrice={markPrice}
              basePrec={basePrec}
            />

            {accountId && (
              <OrderForm
                symbol={symbol}
                market={currentMarket}
                markPrice={markPrice}
                depth={depth}
                positions={enrichedPositions}
                availableBalance={balances.availableBalance}
                accountId={accountId}
                account={account}
              />
            )}
          </div>

          <PositionsTable
            positions={enrichedPositions}
            basePrec={basePrec}
            markets={markets}
            prices={prices}
          />
        </main>
      </div>
    </div>
  );
}
