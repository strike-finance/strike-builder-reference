import { useState, useEffect, useRef } from "react";
import { priceStream } from "../ws/priceStream";
import { getDepth, getMarkPrice } from "../api/account";
import type { MarkPriceUpdate } from "../types/ws";
import type { OrderBookDepthResponse } from "../types/market";

/**
 * Subscribe to price stream for a symbol. Returns live mark prices and depth.
 *
 * On mount:
 *   1. Fetches REST snapshot for depth (/v2/depth) and mark price (/v2/markPrice)
 *   2. Subscribes to WS for real-time updates
 *   3. WS updates layer on top of the REST snapshot
 *
 * @example
 *   const { markPrice, fundingRate, nextFundingTime, depth } = usePriceStream("BTC-USD");
 */
export function usePriceStream(symbol: string) {
  const [prices, setPrices] = useState<Record<string, MarkPriceUpdate>>({});
  const [depth, setDepth] = useState<OrderBookDepthResponse | null>(null);
  const depthRef = useRef<OrderBookDepthResponse | null>(null);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connect WS on mount
  useEffect(() => {
    priceStream.connect();
  }, []);

  useEffect(() => {
    if (!symbol) return;

    let cancelled = false;

    // ── Step 1: Fetch REST snapshots on load ──

    // Fetch initial depth
    getDepth(symbol, 100)
      .then((data) => {
        if (cancelled) return;
        const snapshot: OrderBookDepthResponse = {
          lastUpdateId: data.lastUpdateId ?? 0,
          bids: data.bids ?? [],
          asks: data.asks ?? [],
        };
        depthRef.current = snapshot;
        setDepth(snapshot);
      })
      .catch((e) => console.error("[usePriceStream] Initial depth fetch failed:", e));

    // Fetch initial mark price
    getMarkPrice(symbol)
      .then((data) => {
        if (cancelled) return;
        // Response can be array or single object
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.s === symbol || item?.symbol === symbol) {
            const update: MarkPriceUpdate = {
              e: "markPriceUpdate",
              E: item.E ?? Date.now(),
              s: symbol,
              p: String(item.p ?? item.markPrice ?? item.mark_price ?? "0"),
              i: String(item.i ?? item.indexPrice ?? item.index_price ?? "0"),
              P: String(item.P ?? item.estimatedSettlePrice ?? "0"),
              r: String(item.r ?? item.lastFundingRate ?? item.funding_rate ?? "0"),
              T: Number(item.T ?? item.nextFundingTime ?? item.next_funding_time ?? 0),
            };
            setPrices((prev) => ({ ...prev, [symbol]: update }));
          }
        }
      })
      .catch((e) => console.error("[usePriceStream] Initial mark price fetch failed:", e));

    // ── Step 2: Subscribe to WS for real-time updates ──

    priceStream.subscribe("markPrice", symbol);
    priceStream.subscribe("depth", symbol);

    const unsubMark = priceStream.on(
      `markPriceUpdate:${symbol}`,
      (event: MarkPriceUpdate) => {
        setPrices((prev) => ({ ...prev, [event.s]: event }));
      }
    );

    // Throttled depth updates (150ms leading edge)
    const unsubDepth = priceStream.on(
      `depthUpdate:${symbol}`,
      (event: any) => {
        const snapshot: OrderBookDepthResponse = {
          lastUpdateId: event.u,
          bids: event.b || [],
          asks: event.a || [],
        };
        depthRef.current = snapshot;

        if (!throttleRef.current) {
          setDepth(snapshot);
          throttleRef.current = setTimeout(() => {
            throttleRef.current = null;
            if (depthRef.current) {
              setDepth(depthRef.current);
            }
          }, 150);
        }
      }
    );

    return () => {
      cancelled = true;
      unsubMark();
      unsubDepth();
      priceStream.unsubscribe("markPrice", symbol);
      priceStream.unsubscribe("depth", symbol);
      if (throttleRef.current) clearTimeout(throttleRef.current);
      // Reset on symbol change
      setDepth(null);
    };
  }, [symbol]);

  const markPriceData = prices[symbol];
  const markPrice = markPriceData ? parseFloat(markPriceData.p) : 0;
  const indexPrice = markPriceData ? parseFloat(markPriceData.i) : 0;
  const fundingRate = markPriceData ? parseFloat(markPriceData.r) : 0;
  const nextFundingTime = markPriceData?.T ?? 0;

  return {
    prices,
    markPrice,
    indexPrice,
    fundingRate,
    nextFundingTime,
    depth,
  };
}
