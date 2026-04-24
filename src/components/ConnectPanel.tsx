import { useState, useEffect } from "react";
import {
  generateApiWalletKeys,
  storeApiWalletKeys,
  clearApiWalletKeys,
} from "../api/auth";
import { requestSignature, verifySignature } from "../api/builderConnect";
import {
  detectInstalledWallets,
  connectWallet,
  signMessage,
  type WalletInfo,
  type ConnectedWallet,
  type SupportedChain,
} from "../api/wallets";
import { BUILDER_CODE } from "../api/config";

export interface ConnectedInfo {
  accountId: string;
  chain: SupportedChain;
  address: string;
  builderCode: string;
}

interface Props {
  onConnected: (info: ConnectedInfo) => void;
  onDisconnected: () => void;
  connectedInfo: ConnectedInfo | null;
}

/**
 * Builder Connect flow — all state in memory, no localStorage.
 */
export function ConnectPanel({ onConnected, onDisconnected, connectedInfo }: Props) {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [chain, setChain] = useState<SupportedChain>("cardano");
  const [builderCode, setBuilderCode] = useState(BUILDER_CODE);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setWallets(detectInstalledWallets()), 500);
    return () => clearTimeout(timer);
  }, []);

  const filteredWallets = wallets.filter((w) => w.chain === chain);

  const handleConnect = async (wallet: WalletInfo) => {
    if (!builderCode.trim()) {
      setError("Please enter your builder code first");
      return;
    }

    setError("");
    setLoading(wallet.id);

    try {
      setStatus("Connecting to wallet...");
      const connected: ConnectedWallet = await connectWallet(wallet.chain, wallet.id);

      setStatus("Generating API keys...");
      const keys = generateApiWalletKeys();
      storeApiWalletKeys(keys);

      setStatus("Requesting challenge...");
      const challenge = await requestSignature({
        address: connected.address,
        chain: connected.chain,
        publicKey: keys.publicKey,
        builderCode: builderCode.trim(),
        maxFeeBps: 50,
      });

      setStatus("Sign the message in your wallet...");
      const walletSig = await signMessage(connected, challenge.message_to_sign);

      setStatus("Verifying...");
      const result = await verifySignature({
        address: connected.address,
        chain: connected.chain,
        nonce: challenge.nonce,
        walletSignature: walletSig,
      });

      // Log the full result from verify-signature
      console.log("[Connect] ── Builder Connect Success ──");
      console.log("[Connect] Account ID:", result.account_id);
      console.log("[Connect] Builder Code:", result.builder_code);
      console.log("[Connect] Max Fee BPS:", result.max_fee_bps);
      console.log("[Connect] API Wallet ID:", result.api_wallet_id);
      console.log("[Connect] API Wallet Public Key:", result.api_wallet_public_key);
      console.log("[Connect] Stored Keys PubKey:", keys.publicKey);
      console.log("[Connect] Keys match:", result.api_wallet_public_key === keys.publicKey);

      setStatus("");
      onConnected({
        accountId: result.account_id,
        chain: connected.chain,
        address: connected.address,
        builderCode: builderCode.trim(),
      });
    } catch (e: any) {
      setError(e.message || "Connection failed");
      setStatus("");
    } finally {
      setLoading(null);
    }
  };

  const handleDisconnect = () => {
    clearApiWalletKeys();
    onDisconnected();
  };

  // ── Connected state ──
  if (connectedInfo) {
    const shortAddr = connectedInfo.address
      ? `${connectedInfo.address.slice(0, 8)}...${connectedInfo.address.slice(-6)}`
      : connectedInfo.accountId.slice(0, 12) + "...";

    return (
      <div className="panel">
        <h3>Connected</h3>
        <div className="connected-info">
          <div className="connected-row">
            <span className="text-secondary">Builder</span>
            <span className="chain-badge">{connectedInfo.builderCode}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Chain</span>
            <span className="chain-badge">{connectedInfo.chain}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Address</span>
            <span className="text-sm">{shortAddr}</span>
          </div>
          <div className="connected-row">
            <span className="text-secondary">Account</span>
            <span className="text-sm">{connectedInfo.accountId.slice(0, 12)}...</span>
          </div>
        </div>
        <button onClick={handleDisconnect} className="btn btn-danger" style={{ marginTop: 10 }}>
          Disconnect
        </button>
      </div>
    );
  }

  // ── Connect state ──
  return (
    <div className="panel">
      <h3>Connect Wallet</h3>

      <div className="form-group">
        <label>Builder Code</label>
        <input
          value={builderCode}
          onChange={(e) => setBuilderCode(e.target.value)}
          placeholder="Enter your builder code (e.g. gero)"
          className={!builderCode.trim() ? "input-highlight" : ""}
        />
        <span className="text-xs text-secondary" style={{ marginTop: 2, display: "block" }}>
          Your unique builder code from Strike. Required to connect.
        </span>
      </div>

      <div className="chain-tabs">
        {(["cardano", "solana", "ethereum"] as SupportedChain[]).map((c) => (
          <button
            key={c}
            className={`chain-tab ${chain === c ? "active" : ""}`}
            onClick={() => setChain(c)}
          >
            {c.charAt(0).toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>

      <div className="wallet-list">
        {filteredWallets.length === 0 && (
          <p className="text-secondary text-sm" style={{ padding: "12px 0" }}>
            No {chain} wallets detected. Please install a wallet extension.
          </p>
        )}

        {filteredWallets.map((w) => (
          <button
            key={w.id}
            className="wallet-btn"
            onClick={() => handleConnect(w)}
            disabled={loading !== null}
          >
            {w.icon && <img src={w.icon} alt="" className="wallet-icon" />}
            <span className="wallet-name">{w.name}</span>
            {loading === w.id && <span className="wallet-status">Connecting...</span>}
          </button>
        ))}
      </div>

      {status && <p className="text-secondary text-sm" style={{ marginTop: 8 }}>{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
