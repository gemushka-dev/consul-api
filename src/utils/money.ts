/**
 * Safely converts BIGINT / numeric DB values into JS integer numbers (UZS).
 * Safe up to Number.MAX_SAFE_INTEGER (~9e15 UZS).
 */
export function toSafeInt(val: bigint | number | string | null | undefined): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'bigint') {
    const n = Number(val);
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(`Monetary value exceeds safe integer range: ${val.toString()}`);
    }
    return n;
  }
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return Number.isFinite(val) ? Math.trunc(val) : 0;
}

export function formatMoney(amount: number): string {
  return Math.trunc(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
