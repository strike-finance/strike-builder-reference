import { useState, useMemo, useEffect } from "react";
import { toast } from "react-toastify";
import type { OrderBookDepthResponse, Market } from "../types/market";
import type { Position } from "../types/position";
import type { Account } from "../types/account";
import { estimateMarketFillPrice } from "../math/orderBookUtils";
import { getMaxLeverage } from "../math/marginTiers";
import { formatPrice, formatCurrency, snapToStep, formatSizeForApi } from "../math/formatUtils";
import { placeOrder, updateLeverage, updateMarginMode } from "../api/orders";
import { useOrderValidation } from "../hooks/useOrderValidation";
import { estimateOrderLiquidationPrice } from "../math/positionCalculations";

interface Props {
  symbol: string;
  market: Market | null;
  markPrice: number;
  depth: OrderBookDepthResponse | null;
  positions: Position[];
  availableBalance: number;
  accountId: string | null;
  account: Account | null;
}

/**
 * Order form matching Strike app layout:
 *
 *  [ Cross | Isolated ]  [ 20x ]     <- margin mode + leverage buttons
 *  [ Market | Limit ]                 <- order type tabs
 *  [ Long | Short ]                   <- side toggle
 *  [ Limit Price ]                    <- only for limit orders
 *  [ Size ]  [Max]                    <- size input
 *  [ ] Reduce Only                    <- checkbox
 *  ─── Order Details ───
 *  Est. Entry      $43,251.00
 *  Est. Slippage   0.0231%
 *  Order Value     $21,500.00
 *  Margin          $1,075.00
 *  Est. Fee        $9.68
 *  Available       $8,200.00
 *  ──────────────────────
 *  [ Long BTC-USD ]                   <- submit (shows validation error if invalid)
 *
 * Builder fees are handled server-side based on max_fee_bps from connect flow.
 */
export function OrderForm({
  symbol,
  market,
  markPrice,
  depth,
  positions,
  availableBalance,
  accountId,
  account,
}: Props) {
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── Margin mode & leverage from account symbol_settings ──
  const symbolSettings = account?.symbol_settings?.[symbol];
  const [marginMode, setMarginMode] = useState<"Cross" | "Isolated">(
    symbolSettings?.margin_mode === "isolated" ? "Isolated" : "Cross"
  );
  const [leverage, setLeverage] = useState(
    symbolSettings?.leverage ?? market?.default_leverage ?? 20
  );
  const [showLeverageModal, setShowLeverageModal] = useState(false);
  const [showMarginModal, setShowMarginModal] = useState(false);
  const [tempLeverage, setTempLeverage] = useState(leverage);

  // Sync from account settings when they change
  useEffect(() => {
    if (symbolSettings) {
      setMarginMode(symbolSettings.margin_mode === "isolated" ? "Isolated" : "Cross");
      setLeverage(symbolSettings.leverage);
    } else if (market) {
      setLeverage(market.default_leverage);
    }
  }, [symbolSettings, market]);

  const maxLeverage = getMaxLeverage(market);
  const sizeNum = parseFloat(size) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const basePrec = market?.base_prec ?? 4;
  const baseAsset = market?.base_asset ?? symbol.split("-")[0];
  const takerRate = 0.0005;
  const makerRate = 0.0002;

  // ── Best bid/ask from depth ──
  const bestBid = useMemo(() => {
    if (!depth?.bids?.length) return null;
    return parseFloat(depth.bids[0][0]);
  }, [depth]);
  const bestAsk = useMemo(() => {
    if (!depth?.asks?.length) return null;
    return parseFloat(depth.asks[0][0]);
  }, [depth]);

  // ── Assuming Price (matches Strike app — side-dependent, matches backend margin calc) ──
  const assumingPrice = useMemo(() => {
    if (orderType === "limit") {
      return limitPriceNum || null;
    }
    // Market order: use best bid/ask with slippage buffer
    if (side === "Long") {
      return bestAsk ? bestAsk * 1.0005 : markPrice;
    } else {
      return bestBid && markPrice ? Math.max(bestBid, markPrice) : markPrice;
    }
  }, [orderType, side, limitPriceNum, bestAsk, bestBid, markPrice]);

  // ── Open loss per unit (cost of assuming price vs mark price) ──
  const openLossPerUnit = useMemo(() => {
    if (!assumingPrice || !markPrice) return 0;
    if (side === "Long") return Math.max(0, assumingPrice - markPrice);
    return Math.max(0, markPrice - assumingPrice);
  }, [assumingPrice, markPrice, side]);

  // ── Validation (now with openLossPerUnit) ──
  const { isValid: validationValid, error: validationError } = useOrderValidation({
    size: sizeNum,
    side,
    orderType,
    limitPrice: limitPriceNum,
    leverage,
    reduceOnly,
    market,
    markPrice,
    availableBalance,
    positions,
    symbol,
    openLossPerUnit,
  });

  // ── Immediate liquidation check (matches Strike app NewPerpetualContract) ──
  const isImmediatelyLiquidatable = useMemo(() => {
    if (sizeNum <= 0 || !assumingPrice || assumingPrice <= 0) return false;

    const liqPrice = estimateOrderLiquidationPrice({
      size: sizeNum,
      entryPrice: assumingPrice,
      leverage,
      side,
      markPrice: markPrice ?? 0,
      market,
      marginMode,
      walletBalance: parseFloat(account?.wallet_balance || "0"),
      positions,
    });

    if (liqPrice === null || liqPrice <= 0) return false;

    // For market orders, use markPrice as the effective entry
    const liqEntryPrice = orderType === "market"
      ? (markPrice && markPrice > 0 ? markPrice : assumingPrice)
      : assumingPrice;

    // LONG: liq price must be below entry. If >= entry, instantly liquidatable.
    if (side === "Long") return liqPrice >= liqEntryPrice;
    // SHORT: liq price must be above entry. If <= entry, instantly liquidatable.
    return liqPrice <= liqEntryPrice;
  }, [sizeNum, assumingPrice, leverage, side, markPrice, market, marginMode, account?.wallet_balance, positions, orderType]);

  const isValid = validationValid && !isImmediatelyLiquidatable;

  // ── Estimated entry price ──
  const estimatedEntry = useMemo(() => {
    if (orderType === "limit") return limitPriceNum || null;
    if (sizeNum <= 0) return null;
    return estimateMarketFillPrice(depth, side, sizeNum);
  }, [orderType, limitPriceNum, sizeNum, depth, side]);

  // ── Slippage ──
  const slippage = useMemo(() => {
    if (orderType !== "market" || !estimatedEntry || !markPrice) return null;
    if (side === "Long") return ((estimatedEntry - markPrice) / markPrice) * 100;
    return ((markPrice - estimatedEntry) / markPrice) * 100;
  }, [orderType, estimatedEntry, markPrice, side]);

  // ── Calculations ──
  const assumedPrice = estimatedEntry ?? markPrice;
  const orderValue = sizeNum > 0 && assumedPrice > 0 ? sizeNum * assumedPrice : null;
  const feeRate = orderType === "market" ? takerRate : makerRate;
  const estimatedFee = orderValue ? orderValue * feeRate : null;

  const existingPosition = positions.find((p) => p.symbol === symbol);
  const oppositeSize =
    existingPosition &&
    ((side === "Long" && existingPosition.positionSide === "SHORT") ||
      (side === "Short" && existingPosition.positionSide === "LONG"))
      ? existingPosition.size
      : 0;
  const openingSize = Math.max(0, sizeNum - oppositeSize);
  const openingNotional = openingSize * assumedPrice;
  const marginRequired = leverage > 0 ? openingNotional / leverage : 0;

  const costPerUnit = assumedPrice > 0 && leverage > 0 ? assumedPrice / leverage : 0;
  const maxOpeningSize = costPerUnit > 0 ? availableBalance / costPerUnit : 0;
  const maxSize = oppositeSize + maxOpeningSize;

  // ── Button text ──
  const buttonText = loading
    ? "Submitting..."
    : isImmediatelyLiquidatable
      ? "Would be immediately liquidated"
      : validationError
        ? validationError
        : `${side} ${symbol}`;
  const isDisabled = !isValid || loading;

  // ── Leverage change handler ──
  const handleLeverageConfirm = async () => {
    if (!accountId) return;
    try {
      await updateLeverage(symbol, tempLeverage);
      setLeverage(tempLeverage);
      setShowLeverageModal(false);
      toast.success(`Leverage set to ${tempLeverage}x`);
    } catch (e: any) {
      toast.error(e.message || "Failed to update leverage");
    }
  };

  // ── Margin mode change handler ──
  const handleMarginModeChange = async (mode: "Cross" | "Isolated") => {
    if (!accountId) return;
    try {
      await updateMarginMode(symbol, mode.toLowerCase() as "cross" | "isolated");
      setMarginMode(mode);
      setShowMarginModal(false);
      toast.success(`Margin mode set to ${mode}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to update margin mode");
    }
  };

  // ── Submit ──
  const handleSubmit = async () => {
    if (!isValid || sizeNum <= 0) return;
    setLoading(true);
    try {
      const stepSize = parseFloat(market?.order_market_step_size ?? "0.0001");
      const tickSize = parseFloat(market?.order_tick_price ?? "0.01");

      const request: any = {
        symbol,
        side: side === "Long" ? "buy" : "sell",
        type: orderType,
        size: formatSizeForApi(snapToStep(sizeNum, stepSize, basePrec), basePrec),
        ...(reduceOnly && { reduce_only: true }),
      };

      if (orderType === "limit" && limitPriceNum > 0) {
        request.price = snapToStep(limitPriceNum, tickSize, 2).toString();
        request.time_in_force = "GTC";
      }

      await placeOrder(request);
      toast.success("Order submitted");
      setSize("");
      setLimitPrice("");
    } catch (e: any) {
      toast.error(e.message || "Order failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h3>Place Order</h3>

      {/* ── Margin Mode + Leverage row ── */}
      <div className="trading-mode-row">
        <button
          className="mode-btn"
          onClick={() => setShowMarginModal(true)}
          disabled={!accountId}
        >
          {marginMode}
        </button>
        <button
          className="mode-btn leverage-btn"
          onClick={() => { setTempLeverage(leverage); setShowLeverageModal(true); }}
          disabled={!accountId}
        >
          {leverage}x
        </button>
      </div>

      {/* ── Order Type tabs ── */}
      <div className="order-type-tabs">
        <button
          className={`order-type-tab ${orderType === "market" ? "active" : ""}`}
          onClick={() => setOrderType("market")}
        >
          Market
        </button>
        <button
          className={`order-type-tab ${orderType === "limit" ? "active" : ""}`}
          onClick={() => setOrderType("limit")}
        >
          Limit
        </button>
      </div>

      {/* ── Side toggle ── */}
      <div className="side-toggle">
        <button
          className={`btn ${side === "Long" ? "btn-long active" : ""}`}
          onClick={() => setSide("Long")}
        >
          Long
        </button>
        <button
          className={`btn ${side === "Short" ? "btn-short active" : ""}`}
          onClick={() => setSide("Short")}
        >
          Short
        </button>
      </div>

      {/* ── Limit Price ── */}
      {orderType === "limit" && (
        <div className="form-group">
          <label>Limit Price</label>
          <input
            type="number"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder="0.00"
          />
        </div>
      )}

      {/* ── Size ── */}
      <div className="form-group">
        <label>
          Size ({baseAsset})
          <button className="btn-max" onClick={() => setSize(maxSize.toFixed(basePrec))}>
            Max
          </button>
        </label>
        <input
          type="number"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          placeholder="0.0000"
        />
      </div>

      {/* ── Reduce Only ── */}
      <div className="checkbox-row">
        <input
          type="checkbox"
          id="reduceOnly"
          checked={reduceOnly}
          onChange={(e) => setReduceOnly(e.target.checked)}
        />
        <label htmlFor="reduceOnly">Reduce Only</label>
      </div>

      {/* ── Order details ── */}
      <div className="order-details">
        {estimatedEntry && (
          <div className="detail-row">
            <span>Est. Entry</span>
            <span>{formatPrice(estimatedEntry)}</span>
          </div>
        )}
        {slippage !== null && (
          <div className="detail-row">
            <span>Est. Slippage</span>
            <span>{slippage.toFixed(4)}%</span>
          </div>
        )}
        {orderValue && (
          <div className="detail-row">
            <span>Order Value</span>
            <span>{formatCurrency(orderValue)}</span>
          </div>
        )}
        {marginRequired > 0 && (
          <div className="detail-row">
            <span>Margin</span>
            <span>{formatCurrency(marginRequired)}</span>
          </div>
        )}
        {estimatedFee && (
          <div className="detail-row">
            <span>Est. Fee ({(feeRate * 100).toFixed(3)}%)</span>
            <span>{formatCurrency(estimatedFee)}</span>
          </div>
        )}
        <div className="detail-row">
          <span>Available</span>
          <span>{formatCurrency(availableBalance)}</span>
        </div>
      </div>

      {/* ── Submit ── */}
      <button
        onClick={handleSubmit}
        disabled={isDisabled}
        className={`btn btn-submit ${
          validationError ? "btn-disabled" : side === "Long" ? "btn-long" : "btn-short"
        }`}
      >
        {buttonText}
      </button>

      {/* ── Leverage Modal ── */}
      {showLeverageModal && (
        <div className="modal-overlay" onClick={() => setShowLeverageModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Adjust Leverage</h3>
            <p className="text-secondary text-sm">{symbol}</p>

            <div className="leverage-display">{tempLeverage}x</div>

            <input
              type="range"
              min={1}
              max={maxLeverage}
              value={tempLeverage}
              onChange={(e) => setTempLeverage(Number(e.target.value))}
              className="leverage-slider"
            />

            <div className="leverage-labels">
              <span>1x</span>
              <span>{maxLeverage}x</span>
            </div>

            <div className="leverage-presets">
              {[1, 5, 10, 20, Math.min(50, maxLeverage)].filter((v, i, arr) => arr.indexOf(v) === i).map((v) => (
                <button
                  key={v}
                  className={`preset-btn ${tempLeverage === v ? "active" : ""}`}
                  onClick={() => setTempLeverage(v)}
                >
                  {v}x
                </button>
              ))}
            </div>

            <button onClick={handleLeverageConfirm} className="btn btn-primary">
              Confirm
            </button>
          </div>
        </div>
      )}

      {/* ── Margin Mode Modal ── */}
      {showMarginModal && (
        <div className="modal-overlay" onClick={() => setShowMarginModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Margin Mode</h3>
            <p className="text-secondary text-sm">{symbol}</p>

            <div className="margin-mode-options">
              <button
                className={`margin-mode-option ${marginMode === "Cross" ? "active" : ""}`}
                onClick={() => handleMarginModeChange("Cross")}
              >
                <div className="mode-title">Cross</div>
                <div className="mode-desc">
                  All available balance is shared across cross positions. Liquidation risk is spread.
                </div>
              </button>
              <button
                className={`margin-mode-option ${marginMode === "Isolated" ? "active" : ""}`}
                onClick={() => handleMarginModeChange("Isolated")}
              >
                <div className="mode-title">Isolated</div>
                <div className="mode-desc">
                  Margin is isolated per position. Max loss is limited to the position's margin.
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
