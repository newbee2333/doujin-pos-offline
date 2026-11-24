import { useMemo } from 'react';
import { formatMoney, minorToInput, parseAmountToMinor } from '../domain/money';
import type { Currency } from '../domain/types';

const QUICK_DENOMS: Record<Currency, { minor: number; label: string }[]> = {
  CNY: [
    { minor: 1000, label: '¥10' },
    { minor: 2000, label: '¥20' },
    { minor: 5000, label: '¥50' },
    { minor: 10000, label: '¥100' }
  ],
  JPY: [
    { minor: 1000, label: '¥1,000' },
    { minor: 5000, label: '¥5,000' },
    { minor: 10000, label: '¥10,000' }
  ]
};

/**
 * 统一的现金实收组件：摊主收银台 / 待付款 / 游客付款页摊主区共用。
 * 提供按币种适配的一键面额按钮 + 大字实时找零，减少现场反复呼出虚拟键盘。
 */
export default function CashTenderControl({
  totalMinor,
  currency,
  value,
  onChange,
  disabled = false
}: {
  totalMinor: number;
  currency: Currency;
  value: string;
  onChange: (next: string, isAuto: boolean) => void;
  disabled?: boolean;
}) {
  const change = useMemo(() => {
    if (!value.trim() || totalMinor <= 0) return null;
    try {
      const tendered = parseAmountToMinor(value, currency);
      if (tendered < totalMinor) {
        return {
          danger: true,
          label: '实收不足',
          amount: `还差 ${formatMoney(totalMinor - tendered, currency)}`
        };
      }
      const diff = tendered - totalMinor;
      return {
        danger: false,
        label: diff > 0 ? '应找零' : '金额正好',
        amount: diff > 0 ? formatMoney(diff, currency) : '无需找零'
      };
    } catch (e) {
      return {
        danger: true,
        label: '输入有误',
        amount: e instanceof Error ? e.message : '金额格式不正确'
      };
    }
  }, [value, totalMinor, currency]);

  const denoms = QUICK_DENOMS[currency];

  return (
    <div className="cash-tender">
      <div className="field-label">
        <span>实收金额（{currency === 'CNY' ? '元' : '日元'}）</span>
        <button
          type="button"
          className="link-btn"
          disabled={disabled || totalMinor <= 0}
          onClick={() => {
            if (totalMinor <= 0) return;
            onChange(minorToInput(totalMinor, currency), true);
          }}
        >
          按应付金额
        </button>
      </div>

      <input
        type="text"
        inputMode={currency === 'JPY' ? 'numeric' : 'decimal'}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value, false)}
        placeholder={currency === 'CNY' ? '0.00' : '0'}
        aria-label="实收金额"
      />

      <div className="cash-quick-row" role="group" aria-label="快捷面额">
        {denoms.map((d) => (
          <button
            key={d.minor}
            type="button"
            className="cash-quick-btn"
            disabled={disabled}
            onClick={() => onChange(minorToInput(d.minor, currency), false)}
          >
            {d.label}
          </button>
        ))}
      </div>

      {change ? (
        <div className={`cash-change-banner${change.danger ? ' danger' : ''}`} role="status">
          <span>{change.label}</span>
          <strong>{change.amount}</strong>
        </div>
      ) : null}
    </div>
  );
}
