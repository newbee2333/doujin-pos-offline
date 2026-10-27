export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: '待付款', completed: '已完成', voided: '已取消', refunded: '已退款', corrected: '已纠错'
};
export function orderStatusClass(status: string) {
  return status === 'completed' ? 'ok' : status === 'pending_payment' ? 'warn' : status === 'voided' ? '' : 'danger';
}
