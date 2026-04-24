import { useMemo } from "react";
import type { Position } from "../types/position";
import type { Market } from "../types/market";
import type { MarkPriceUpdate } from "../types/ws";
import type { Account } from "../types/account";
import {
  enrichPositionWithDerived,
  applyCrossLiquidationPrices,
} from "../math/positionCalculations";

/**
 * Enrich positions with all derived fields using live mark prices.
 * Recalculates on every mark price change.
 *
 * Leverage fallback (matches Strike app UserStreamContext lines 193-196):
 *   position.leverage ?? account.symbol_settings[symbol].leverage ?? market.default_leverage
 *
 * This is critical because WS ACCOUNT_UPDATE doesn't send leverage,
 * so new positions from WS would have leverage=0 without this fallback.
 */
export function useEnrichedPositions(
  positions: Position[],
  prices: Record<string, MarkPriceUpdate>,
  markets: Record<string, Market>,
  walletBalance: number,
  account?: Account | null
): Position[] {
  return useMemo(() => {
    // Step 1: Basic enrichment with leverage fallback
    const basicEnriched = positions.map((position) => {
      const symbol = position.symbol;
      const markPriceData = prices[symbol];
      const markPrice = markPriceData
        ? parseFloat(markPriceData.p || markPriceData.i || "0")
        : 0;
      const market = markets[symbol];

      // Leverage fallback: position → account symbol_settings → market default
      const leverage =
        position.leverage ||
        account?.symbol_settings?.[symbol]?.leverage ||
        market?.default_leverage ||
        1;

      return enrichPositionWithDerived(
        { ...position, leverage },
        markPrice,
        market
      );
    });

    // Step 2: Apply cross liquidation prices (needs all positions' context)
    return applyCrossLiquidationPrices(basicEnriched, walletBalance, markets);
  }, [positions, prices, markets, walletBalance, account]);
}
