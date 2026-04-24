import { formatCurrency, formatSignedCurrency } from "../math/formatUtils";

interface Props {
  walletBalance: number;
  availableBalance: number;
  marginBalance: number;
  positionValue: number;
  totalUnrealizedPnL: number;
}

/**
 * Account balance panel.
 *
 * Shows:
 *   Account Value = walletBalance + totalUnrealizedPnL
 *   Available Balance = wallet - orderCosts - isolated - crossReq
 *   Position Value = sum(currentMargin + uPnL)
 *   Unrealized PnL = sum of all positions' uPnL
 */
export function AccountPanel({
  walletBalance,
  availableBalance,
  marginBalance,
  positionValue,
  totalUnrealizedPnL,
}: Props) {
  return (
    <div className="panel account-panel">
      <h3>Account</h3>
      <div className="account-grid">
        <div className="account-item">
          <span className="label">Account Value</span>
          <span className="value">{formatCurrency(marginBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Available Balance</span>
          <span className="value">{formatCurrency(availableBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Wallet Balance</span>
          <span className="value">{formatCurrency(walletBalance)}</span>
        </div>
        <div className="account-item">
          <span className="label">Position Value</span>
          <span className="value">{formatCurrency(positionValue)}</span>
        </div>
        <div className="account-item">
          <span className="label">Unrealized PnL</span>
          <span className={`value ${totalUnrealizedPnL >= 0 ? "text-green" : "text-red"}`}>
            {formatSignedCurrency(totalUnrealizedPnL)}
          </span>
        </div>
      </div>
    </div>
  );
}
