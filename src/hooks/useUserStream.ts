import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "react-toastify";
import { userStream } from "../ws/userStream";
import { getAccount, getPositions, getOpenOrders } from "../api/account";
import type { Position } from "../types/position";
import type { Account } from "../types/account";

// ═══════════════════════════════════════════════════════════════════
// CLOSE REASON MAPPING (matches Strike app utils/errors/errorMessageUtils.ts)
// ═══════════════════════════════════════════════════════════════════

const CLOSE_REASON_MAP: Record<string, string> = {
  market_order_exceeded_slippage: "Market order exceeded slippage tolerance",
  insufficient_balance: "Insufficient balance",
  order_less_than_min_size: "Order below minimum size",
  order_size_exceed: "Order size exceeds maximum",
  order_less_than_min_notional: "Order below minimum notional value",
  order_size_not_multiple_of_step: "Order size is not a multiple of step size",
  order_price_out_of_limit: "Order price out of limit",
  order_price_out_of_price_cap: "Order price exceeds price cap",
  order_price_out_of_price_floor: "Order price below price floor",
  order_price_not_multiple_of_tick: "Order price is not a multiple of tick size",
  order_price_exceeds_maximum: "Order price exceeds maximum",
  conditional_order_triggers_immediately: "Conditional order would trigger immediately",
  no_open_position: "No open position",
  order_increase_position: "Reduce-only order would increase position",
  invalid_order: "Invalid order",
  invalid_order_size: "Invalid order size",
  invalid_order_price: "Invalid order price",
  invalid_order_side: "Invalid order side",
  invalid_order_type: "Invalid order type",
  invalid_stop_price: "Invalid stop price",
  stop_price_not_multiple_of_tick: "Stop price is not a multiple of tick size",
  stop_price_out_of_limit: "Stop price out of limit",
  order_not_found: "Order not found",
  order_not_allowed: "Order not allowed",
  liquidation: "Liquidation",
  invalid_reduce_margin: "Invalid margin reduction",
  invalid_margin_mode: "Invalid margin mode",
  slippage_must_be_positive: "Slippage must be positive",
  slippage_only_for_market_orders: "Slippage only applies to market orders",
};

function mapCloseReason(reason: string): string {
  if (!reason) return "Unknown error";
  return CLOSE_REASON_MAP[reason.toLowerCase().trim()] ?? reason.replace(/_/g, " ");
}

// ── Normalize helpers (match Strike app patterns) ──

const toNumber = (value: any): number => {
  const num = typeof value === "string" ? parseFloat(value) : Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
};

/** Normalize position from REST API (PascalCase / snake_case mixed) */
function normalizePositionFromApi(raw: any): Position {
  const size = toNumber(raw?.Size ?? raw?.size ?? raw?.pa ?? 0);
  const absoluteSize = Math.abs(size);
  const sideRaw = String(raw?.Side ?? raw?.positionSide ?? raw?.position_side ?? raw?.ps ?? "long");
  const positionSide: "LONG" | "SHORT" = sideRaw.toUpperCase() === "SHORT" ? "SHORT" : "LONG";

  return {
    symbol: raw?.symbol || raw?.s || "",
    size: absoluteSize,
    entryPrice: toNumber(raw?.EntryPrice ?? raw?.entryPrice ?? raw?.entry_price ?? raw?.ep ?? 0),
    positionSide,
    marginMode: (String(raw?.MarginMode ?? raw?.marginMode ?? raw?.margin_mode ?? raw?.mt ?? "cross")).toLowerCase() as "cross" | "isolated",
    isoBalance: toNumber(raw?.IsolatedMargin ?? raw?.isoBalance ?? raw?.iso_balance ?? raw?.ib ?? 0),
    leverage: toNumber(raw?.Leverage ?? raw?.leverage ?? 0),
    accumulatedFundingFees: toNumber(raw?.accumulatedFundingFees ?? raw?.accumulated_funding_fees ?? 0),
    id: raw?.PositionID || raw?.id || raw?.i || undefined,
    // Server-computed fields (use as initial values, will be overridden by client-side enrichment)
    uPnL: toNumber(raw?.upnl ?? 0) || undefined,
    liquidationPrice: toNumber(raw?.liquidation_price ?? 0) || undefined,
    maintenanceMargin: toNumber(raw?.maintenance_margin ?? 0) || undefined,
  };
}

/** Normalize position from WS ACCOUNT_UPDATE (lowercase single-letter keys) */
function normalizePositionFromWs(raw: any): Position {
  return {
    symbol: String(raw?.s ?? ""),
    size: Math.abs(toNumber(raw?.pa ?? 0)),
    entryPrice: toNumber(raw?.ep ?? 0),
    positionSide: String(raw?.ps ?? "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG",
    marginMode: String(raw?.mt ?? "cross").toLowerCase() as "cross" | "isolated",
    isoBalance: toNumber(raw?.ib ?? 0),
    leverage: 0, // Not provided via WS — use from existing or account settings
    accumulatedFundingFees: 0, // Not provided via WS — preserve from existing
    id: raw?.i ? String(raw.i) : undefined,
  };
}

/** Merge WS position updates into current positions (same as Strike mergePositions) */
function mergePositions(current: Position[], updates: Position[]): Position[] {
  if (!updates.length) return current;

  const map = new Map(current.map((p) => [`${p.symbol}-${p.positionSide}`, p]));

  for (const update of updates) {
    const key = `${update.symbol}-${update.positionSide}`;

    if (update.size < 1e-12) {
      map.delete(key);
    } else {
      const existing = map.get(key);
      // Remove opposite side (handles position flips)
      const oppSide = update.positionSide === "LONG" ? "SHORT" : "LONG";
      map.delete(`${update.symbol}-${oppSide}`);

      map.set(key, {
        ...update,
        // Preserve fields not sent via WS
        leverage: existing?.leverage ?? update.leverage,
        accumulatedFundingFees: existing?.accumulatedFundingFees ?? update.accumulatedFundingFees,
        id: update.id || existing?.id,
      });
    }
  }

  return Array.from(map.values());
}

/** Normalize order from REST API (PascalCase) to a common format */
function normalizeOrderFromApi(raw: any): any {
  return {
    Id: raw.ID ?? raw.Id ?? raw.id ?? 0,
    ClientOrderId: raw.ClientOrderID ?? raw.ClientOrderId ?? raw.client_order_id ?? "",
    Symbol: raw.Symbol ?? raw.symbol ?? "",
    Side: raw.Side ?? raw.side ?? "",
    Status: raw.Status ?? raw.status ?? "",
    Type: raw.Type ?? raw.type ?? "",
    OriginType: raw.OriginType ?? raw.origin_type ?? "",
    Size: raw.Size ?? raw.size ?? "0",
    Price: raw.Price ?? raw.price ?? "0",
    StopPrice: raw.StopPrice ?? raw.stop_price ?? "0",
    Filled: raw.Filled ?? raw.filled ?? "0",
    ReduceOnly: raw.ReduceOnly ?? raw.reduce_only ?? false,
    PostOnly: raw.PostOnly ?? raw.post_only ?? false,
    WorkingType: raw.WorkingType ?? raw.working_type ?? "",
    TimeInForce: raw.TimeInForce ?? raw.time_in_force ?? "GTC",
    CreateTimestamp: raw.CreateTimestamp ?? raw.create_timestamp ?? raw.EntryTimestamp ?? 0,
    Strategy: raw.Strategy ?? raw.strategy ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════

/**
 * User data stream — matches Strike app UserStreamContext pattern:
 *
 * 1. On connect: parallel REST fetch of /v2/account + /v2/positions + /v2/openOrders
 * 2. Subscribe to WS for real-time updates
 * 3. ACCOUNT_UPDATE: update wallet_balance + merge positions
 * 4. ORDER_TRADE_UPDATE: update orders list
 * 5. Toasts on liquidation, ADL, deposit, withdraw, fills
 */
export function useUserStream(accountId: string | null) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const isMountedRef = useRef(true);

  // Toast deduplication cache (matches Strike app processedOrderUpdatesRef)
  const toastCacheRef = useRef<Map<string, number>>(new Map());

  // Order update buffer — 300ms batching for replace-order (cancel + new)
  const orderBufferRef = useRef<any[]>([]);
  const orderFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (orderFlushTimerRef.current) {
        clearTimeout(orderFlushTimerRef.current);
        orderFlushTimerRef.current = null;
      }
    };
  }, []);

  // ── ORDER_TRADE_UPDATE toast (matches Strike app processOrderTradeUpdate) ──
  const showOrderToast = useCallback((event: any) => {
    const orderId = event.i ?? event.orderID ?? 0;
    const status = (event.X ?? event.orderStatus ?? "").toUpperCase();
    const symbol = event.s ?? event.symbol ?? "";
    const cr = event.cr ?? "";

    const tradeId = event.t ?? 0;
    const lastFilledQty = event.l ?? "";
    const lastFilledPrice = event.L ?? "";
    const fee = event.n ?? "";

    // Fill-data guard: only show fill toasts when we have actual fill data
    // (prevents duplicates when backend sends preview + actual fill messages)
    const hasFillFields = tradeId > 0 || lastFilledQty || lastFilledPrice || fee;
    const isFillStatus = status === "FILLED" || status === "PARTIALLY_FILLED";

    const shouldShowToast =
      (isFillStatus && hasFillFields) ||
      status === "REJECTED" ||
      status === "CANCELED" ||
      status === "CANCELLED";

    if (!shouldShowToast) return;

    // Deduplication by orderId + status
    const key = `${orderId}-${status}`;
    const cache = toastCacheRef.current;
    if (cache.has(key)) return;
    cache.set(key, Date.now());
    // Prune old entries
    if (cache.size > 200) {
      const cutoff = Date.now() - 60000;
      for (const [k, ts] of cache) if (ts < cutoff) cache.delete(k);
    }

    // Format toast — matching Strike app orderNotificationHandler.ts exactly
    const side = (event.S ?? "").toUpperCase() === "BUY" ? "Buy" : "Sell";

    if (status === "REJECTED") {
      toast.error(mapCloseReason(cr || "unknown_error"));
    } else if (status === "FILLED" || status === "PARTIALLY_FILLED") {
      // Use last fill fields, fall back to cumulative/order qty
      const qty = (lastFilledQty && parseFloat(lastFilledQty) > 0 ? lastFilledQty : "") ||
        (event.z && parseFloat(event.z) > 0 ? event.z : "") ||
        (event.q ?? "0");
      const price = (lastFilledPrice && parseFloat(lastFilledPrice) > 0 ? lastFilledPrice : "") ||
        (event.p && parseFloat(event.p) > 0 ? event.p : "");

      if (price && parseFloat(price) > 0) {
        toast.success(`Order Filled: ${side} ${qty} ${symbol} at $${parseFloat(price).toFixed(4)}`);
      } else {
        toast.success(`Order Filled: ${side} ${qty} ${symbol}`);
      }
    } else if (status === "CANCELED" || status === "CANCELLED") {
      // Slippage exceeded = error toast (matches Strike app)
      if (cr === "market_order_exceeded_slippage") {
        toast.error(mapCloseReason(cr));
      } else {
        const qty = event.q ?? "0";
        toast.success(`Order Cancelled: ${side} ${qty} ${symbol}`);
      }
    }
  }, []);

  // ── Buffered order state update (300ms batching) ──
  const bufferOrderUpdate = useCallback((event: any) => {
    orderBufferRef.current.push(event);
    if (!orderFlushTimerRef.current) {
      orderFlushTimerRef.current = setTimeout(() => {
        const batch = orderBufferRef.current.splice(0);
        orderFlushTimerRef.current = null;
        if (batch.length === 0) return;

        setOrders((prev) => {
          let result = prev;
          for (const evt of batch) {
            result = applyOrderUpdate(result, evt);
          }
          return result;
        });
      }, 300);
    }
  }, []);

  // ── Step 1: Fetch initial data via REST ──
  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      setPositions([]);
      setOrders([]);
      return;
    }

    setIsLoading(true);

    Promise.all([
      getAccount().catch((e) => { console.error("[useUserStream] getAccount failed:", e); return null; }),
      getPositions().catch((e) => { console.error("[useUserStream] getPositions failed:", e); return []; }),
      getOpenOrders().catch((e) => { console.error("[useUserStream] getOpenOrders failed:", e); return []; }),
    ]).then(([acc, pos, ords]) => {
      if (!isMountedRef.current) return;

      if (acc) {
        console.log("[useUserStream] Account loaded:", acc.account_id, "balance:", acc.wallet_balance);
        setAccount(acc);
      }

      if (Array.isArray(pos)) {
        const normalized = pos.map(normalizePositionFromApi);
        console.log("[useUserStream] Positions loaded:", normalized.length);
        setPositions(normalized);
      }

      if (Array.isArray(ords)) {
        const normalized = ords.map(normalizeOrderFromApi);
        console.log("[useUserStream] Open orders loaded:", normalized.length);
        setOrders(normalized);
      }

      setIsLoading(false);
    });
  }, [accountId]);

  // ── Step 2: Connect WS for real-time updates ──
  useEffect(() => {
    if (!accountId) return;

    userStream.connect(accountId);

    // ACCOUNT_UPDATE handler (matches Strike app handleAccountUpdateMessage)
    const unsubAccount = userStream.on("ACCOUNT_UPDATE", (event: any) => {
      if (!isMountedRef.current) return;

      // Update wallet_balance
      const primaryBalance = event.B?.[0]?.wb;
      if (primaryBalance !== undefined && primaryBalance !== null) {
        setAccount((prev) =>
          prev ? { ...prev, wallet_balance: String(primaryBalance) } : prev
        );
      }

      // Merge position updates
      const rawPositions = event.P ?? [];
      if (rawPositions.length > 0) {
        const updates = rawPositions.map(normalizePositionFromWs);
        setPositions((prev) => mergePositions(prev, updates));
      }

      // Reason — matches Strike app: reads r, EventReasonType, eventReasonType, reason, e, m
      // The "m" field matches Go struct AccountUpdateData.EventReasonType json:"m"
      const reason = String(
        event.r ?? event.EventReasonType ?? event.eventReasonType ??
        event.reason ?? event.m ?? ""
      ).toUpperCase();

      if (reason === "DEPOSIT") {
        const bc = event.B?.[0]?.bc;
        const amount = bc ? parseFloat(bc) : 0;
        if (amount > 0) toast.success(`Deposit received: +$${amount.toFixed(2)}`);
      }
      if (reason === "WITHDRAW" || reason === "WITHDRAWAL_SETTLED") {
        const bc = event.B?.[0]?.bc;
        const amount = bc ? Math.abs(parseFloat(bc)) : 0;
        if (amount > 0) toast.success(`Withdrawal processed: $${amount.toFixed(2)}`);
      }
      if (reason === "WITHDRAWAL_FAILED") {
        toast.error("Withdrawal failed");
      }

      // Liquidation / ADL (matches Strike app exactly)
      const symbols = (event.P ?? [])
        .map((p: any) => String(p?.s ?? ""))
        .filter(Boolean);
      const symbol = symbols[0] || "position";

      if (reason === "PARTIAL_LIQUIDATED") {
        toast.error(`Your ${symbol} position was partially liquidated`);
      }
      if (reason === "FULLY_LIQUIDATED") {
        toast.error(`Your ${symbol} position was fully liquidated`);
      }
      if (reason === "ADL") {
        toast.error(`Your ${symbol} position was auto-deleveraged`);
      }
    });

    // ORDER_TRADE_UPDATE handler (matches Strike app handleOrderTradeUpdateMessage)
    const unsubOrder = userStream.on("ORDER_TRADE_UPDATE", (event: any) => {
      if (!isMountedRef.current) return;

      // Show toast (with dedup + fill-data guard)
      showOrderToast(event);

      // Buffer order state update (300ms batch for replace-order atomicity)
      bufferOrderUpdate(event);
    });

    return () => {
      unsubAccount();
      unsubOrder();
      userStream.disconnect();
    };
  }, [accountId, showOrderToast, bufferOrderUpdate]);

  // Derived wallet balance from account object
  const walletBalance = account ? parseFloat(account.wallet_balance || "0") : 0;

  return { positions, orders, walletBalance, account, isLoading };
}

// ═══════════════════════════════════════════════════════════════════
// ORDER STATE UPDATE (matches Strike app applyOrderTradeUpdate)
// ═══════════════════════════════════════════════════════════════════

const FINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"]);

function applyOrderUpdate(currentOrders: any[], event: any): any[] {
  const orderId = event.i ?? event.orderID ?? 0;
  const clientOrderId = event.c ?? "";
  const status = String(event.X ?? event.orderStatus ?? "").toUpperCase();

  // Find by orderId or clientOrderId
  const index = currentOrders.findIndex(
    (o) => o.Id === orderId || (clientOrderId && o.ClientOrderId === clientOrderId)
  );

  if (index === -1) {
    // Not in list — only add if not a final status
    if (FINAL.has(status)) return currentOrders;

    return [buildOrderData(event, status), ...currentOrders];
  }

  // Final status: remove from open orders
  if (FINAL.has(status)) {
    const updated = [...currentOrders];
    updated.splice(index, 1);
    return updated;
  }

  // Update existing
  const updated = [...currentOrders];
  updated[index] = { ...updated[index], ...buildOrderData(event, status) };
  return updated;
}

function buildOrderData(event: any, status: string): any {
  return {
    Id: event.i ?? event.orderID ?? 0,
    ClientOrderId: event.c ?? "",
    Symbol: event.s ?? event.symbol ?? "",
    Side: event.S ?? "",
    Status: status.toLowerCase(),
    Type: event.o ?? "",
    OriginType: event.ot ?? "",
    Size: event.q ?? "0",
    Price: event.p ?? "0",
    StopPrice: event.sp ?? "0",
    Filled: event.z ?? "0",
    ReduceOnly: event.R ?? false,
    WorkingType: event.wt ?? "",
    CloseReason: event.cr ?? "",
    CallbackRate: event.CR ?? "",
    ActivationPrice: event.AP ?? "",
    CreateTimestamp: event.T ?? event.E ?? 0,
  };
}
