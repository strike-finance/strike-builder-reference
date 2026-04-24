import { useState } from "react";
import { getWithdrawQuote, confirmWithdraw } from "../api/withdraw";

interface Props {
  chain: "ethereum" | "solana" | "cardano";
  withdrawableBalance: number;
}

/**
 * Withdrawal flow UI (2 steps).
 *
 * 1. Enter USD amount -> POST /v2/withdraw/quote
 *    (backend uses registered wallet address, NOT user-specified)
 * 2. User signs message_to_sign with wallet -> POST /v2/withdraw
 */
export function WithdrawPanel({ chain, withdrawableBalance }: Props) {
  const [step, setStep] = useState<"amount" | "sign" | "done">("amount");
  const [usdAmount, setUsdAmount] = useState("");
  const [withdrawId, setWithdrawId] = useState("");
  const [messageToSign, setMessageToSign] = useState("");
  const [fee, setFee] = useState("");
  const [walletSig, setWalletSig] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGetQuote = async () => {
    setError("");
    setLoading(true);
    try {
      const quote = await getWithdrawQuote({
        usd_value: usdAmount,
        blockchain: chain,
      });
      setWithdrawId(quote.withdraw_id);
      setMessageToSign(quote.message_to_sign);
      setFee(quote.fee);
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
      await confirmWithdraw({
        withdraw_id: withdrawId,
        wallet_signature: walletSig,
      });
      setStep("done");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <h3>Withdraw</h3>

      {step === "amount" && (
        <>
          <p className="text-secondary text-xs">
            Max: ${withdrawableBalance.toFixed(2)}
          </p>
          <div className="form-group">
            <label>USD Amount</label>
            <input
              type="number"
              value={usdAmount}
              onChange={(e) => setUsdAmount(e.target.value)}
              placeholder="500.00"
            />
          </div>
          <button
            onClick={handleGetQuote}
            disabled={!usdAmount || loading}
            className="btn btn-primary"
          >
            {loading ? "Getting quote..." : "Get Quote"}
          </button>
        </>
      )}

      {step === "sign" && (
        <>
          <p>Fee: <strong>${fee}</strong></p>
          <div className="form-group">
            <label>Sign this message with your wallet:</label>
            <textarea readOnly value={messageToSign} rows={6} className="code-block" />
          </div>
          <div className="form-group">
            <label>Paste wallet signature:</label>
            <input
              value={walletSig}
              onChange={(e) => setWalletSig(e.target.value)}
              placeholder="Wallet signature"
            />
          </div>
          <button
            onClick={handleConfirm}
            disabled={!walletSig || loading}
            className="btn btn-primary"
          >
            {loading ? "Processing..." : "Confirm Withdrawal"}
          </button>
        </>
      )}

      {step === "done" && (
        <>
          <p className="text-green">Withdrawal submitted!</p>
          <button onClick={() => { setStep("amount"); setWalletSig(""); }} className="btn btn-secondary">
            New Withdrawal
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
