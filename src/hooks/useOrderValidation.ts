import { useMemo } from "react";
import type { Market } from "../types/market";
import type { Position } from "../types/position";
import {
  getMaxPositionSizeForLeverage,
  getMaxLeverageForNotional,
} from "../math/marginTiers";

export interface OrderValidationParams {
  size: number; // in base asset
  side: "Long" | "Short";
  orderType: "market" | "limit";
  limitPrice: number;
  leverage: number;
  reduceOnly: boolean;
  market: Market | null;
  markPrice: number;
  availableBalance: number;
  positions: Position[];
  symbol: string;
  openLossPerUnit?: number;
}

export interface OrderValidationResult {
  isValid: boolean;
  error: string | null;
}

/**
 * Validate an order against market constraints, balance, and tier limits.
 *
 * Checks (in order):
 * 1. Market available & trading
 * 2. Min size
 * 3. Max size (market limit + tier limit for leverage)
 * 4. Size step validation
 * 5. Min notional (skipped for reduce-only)
 * 6. Leverage vs tier max leverage
 * 7. Available balance check (skipped for reduce-only)
 * 8. Limit price bounds
 *
 * Error shows in the submit button text (same pattern as Strike app).
 */
export function useOrderValidation(
  params: OrderValidationParams
): OrderValidationResult {
  return useMemo(() => {
    const {
      size,
      side,
      orderType,
      limitPrice,
      leverage,
      reduceOnly,
      market,
      markPrice,
      availableBalance,
      positions,
      symbol,
      openLossPerUnit = 0,
    } = params;

    // No size entered yet — not an error, just incomplete
    if (size <= 0) return { isValid: false, error: null };

    // 1. Market available
    if (!market) return { isValid: false, error: "Market not available" };

    // 2. Market status
    if (market.status !== "trading") {
      return { isValid: false, error: `Market is ${market.status}` };
    }

    const isLimit = orderType === "limit";
    const currentPrice = isLimit && limitPrice > 0 ? limitPrice : markPrice;
    if (currentPrice <= 0) return { isValid: false, error: null };

    // 3. Min size
    const minSize = parseFloat(
      isLimit ? market.order_limit_min_size : market.order_market_min_size
    );
    if (size < minSize) {
      return {
        isValid: false,
        error: `Min size: ${minSize} ${market.base_asset}`,
      };
    }

    // 4. Max size (market/limit max + tier max)
    const marketMaxSize = parseFloat(
      isLimit ? market.order_limit_max_size : market.order_market_max_size
    );

    // Tier max: account for existing positions
    const existingPos = positions.find((p) => p.symbol === symbol);
    const sameDirectionSize =
      existingPos &&
      ((side === "Long" && existingPos.positionSide === "LONG") ||
        (side === "Short" && existingPos.positionSide === "SHORT"))
        ? existingPos.size
        : 0;
    const oppositeSize =
      existingPos &&
      ((side === "Long" && existingPos.positionSide === "SHORT") ||
        (side === "Short" && existingPos.positionSide === "LONG"))
        ? existingPos.size
        : 0;

    const tierMaxNotional = getMaxPositionSizeForLeverage(market, leverage);
    const tierMaxSize = tierMaxNotional
      ? tierMaxNotional / currentPrice
      : Infinity;
    const maxOrderFromTier =
      tierMaxSize - sameDirectionSize + oppositeSize;

    const effectiveMax = Math.min(marketMaxSize, maxOrderFromTier);
    if (size > effectiveMax && effectiveMax > 0) {
      return {
        isValid: false,
        error: `Max size: ${effectiveMax.toFixed(market.base_prec)} ${market.base_asset}`,
      };
    }

    // 5. Size step
    const stepSize = parseFloat(
      isLimit ? market.order_limit_step_size : market.order_market_step_size
    );
    if (stepSize > 0) {
      const remainder = size % stepSize;
      if (remainder > stepSize * 0.01 && remainder < stepSize * 0.99) {
        return {
          isValid: false,
          error: `Size must be multiple of ${stepSize}`,
        };
      }
    }

    // 6. Min notional (skip for reduce-only)
    if (!reduceOnly) {
      const notional = size * currentPrice;
      const minNotional = parseFloat(market.order_min_notional);
      if (notional < minNotional) {
        return {
          isValid: false,
          error: `Min order value: $${minNotional}`,
        };
      }
    }

    // 7. Leverage vs tier limit
    const resultingSize = sameDirectionSize + size - oppositeSize;
    if (resultingSize > 0) {
      const resultingNotional = resultingSize * currentPrice;
      const maxLev = getMaxLeverageForNotional(market, resultingNotional);
      if (leverage > maxLev) {
        return {
          isValid: false,
          error: `Max leverage at this size: ${maxLev}x`,
        };
      }
    }

    // 8. Available balance check (skip for reduce-only)
    if (!reduceOnly) {
      const openingSize = Math.max(0, size - oppositeSize);
      if (openingSize > 0) {
        const openingNotional = openingSize * currentPrice;
        const requiredMargin =
          openingNotional / leverage + openingSize * openLossPerUnit;
        if (requiredMargin > availableBalance) {
          return { isValid: false, error: "Insufficient balance" };
        }
      }
    }

    // 9. Limit price bounds
    if (isLimit && limitPrice > 0 && markPrice > 0) {
      const priceBound = parseFloat(market.order_limit_price_bound || "0");
      if (priceBound > 0) {
        const apiSide = side === "Long" ? "buy" : "sell";
        if (
          apiSide === "buy" &&
          limitPrice > markPrice * (1 + priceBound)
        ) {
          return { isValid: false, error: "Buy price exceeds price cap" };
        }
        if (
          apiSide === "sell" &&
          limitPrice < markPrice * (1 - priceBound)
        ) {
          return { isValid: false, error: "Sell price below price floor" };
        }
      }
    }

    return { isValid: true, error: null };
  }, [params]);
}
