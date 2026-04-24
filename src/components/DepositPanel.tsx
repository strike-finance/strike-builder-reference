import { useState } from "react";
import { getDepositQuote, buildDepositTx, confirmDeposit } from "../api/deposit";

interface Props {
  accountId: string;
  chain: "ethereum" | "solana" | "cardano";
}

/**
 * Deposit flow UI (3 steps).
 *
 * 1. Enter amount -> POST /v2/deposit/quote
 * 2. Build unsigned TX -> POST /v2/deposit/build-tx
 *    User signs in their wallet (outside this app)
 * 3. Paste tx hash -> POST /v2/deposit (confirm)
 */
export function DepositPanel({ accountId, chain }: Props) {
  const [step, setStep] = useState<"amount" | "sign" | "confirm" | "done">("amount");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("USDC");
  const [requestId, setRequestId] = useState("");
  const [unsignedTx, setUnsignedTx] = useState("");
  const [txHash, setTxHash] = useState("");
  const [usdValue, setUsdValue] = useState("");
  const [depositAddress, setDepositAddress] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGetQuote = async () => {
    setError("");
    setLoading(true);
    try {
      const quote = await getDepositQuote({
        blockchain: chain,
        asset_symbol: asset,
        asset_amount: amount,
      });
      setRequestId(quote.request_id);
      setUsdValue(quote.quote.usd_value);
      setDepositAddress(quote.deposit_address);

      // Build unsigned TX
      const tx = await buildDepositTx({
        request_id: quote.request_id,
        user_address: "", // user fills this or it comes from connect
      });
      setUnsignedTx(
        typeof tx.unsigned_tx === "string"
          ? tx.unsigned_tx
          : JSON.stringify(tx.unsigned_tx, null, 2)
      );
      setStep("sign");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setError("");
    setLoading(true);
    try {
      await confirmDeposit({ request_id: requestId, tx_hash: txHash });
      setStep("done");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h3>Deposit</h3>

      {step === "amount" && (
        <>
          <div className="form-group">
            <label>Asset</label>
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="USDC">USDC</option>
              <option value="ADA">ADA</option>
              <option value="SOL">SOL</option>
              <option value="ETH">ETH</option>
            </select>
          </div>
          <div className="form-group">
            <label>Amount (smallest unit: lamports/lovelace/wei)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1000000000"
            />
          </div>
          <button onClick={handleGetQuote} disabled={!amount || loading} className="btn btn-primary">
            {loading ? "Getting quote..." : "Get Quote"}
          </button>
        </>
      )}

      {step === "sign" && (
        <>
          <p>USD Value: <strong>${usdValue}</strong></p>
          <p className="text-secondary text-xs">Deposit to: {depositAddress}</p>
          <div className="form-group">
            <label>Unsigned Transaction (sign with your wallet):</label>
            <textarea readOnly value={unsignedTx} rows={4} className="code-block" />
          </div>
          <div className="form-group">
            <label>Paste TX hash after signing & submitting:</label>
            <input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="tx hash" />
          </div>
          <button onClick={handleConfirm} disabled={!txHash || loading} className="btn btn-primary">
            {loading ? "Confirming..." : "Confirm Deposit"}
          </button>
        </>
      )}

      {step === "done" && (
        <>
          <p className="text-green">Deposit submitted! Awaiting blockchain confirmation.</p>
          <button onClick={() => { setStep("amount"); setTxHash(""); }} className="btn btn-secondary">
            New Deposit
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
