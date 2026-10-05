import { INVOICE_STATUS_LABEL, INVOICE_STATUS_STYLE } from '../lib/format';
import type { InvoiceStatus } from '../lib/types';

export function InvoiceBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${INVOICE_STATUS_STYLE[status]}`}>
      {INVOICE_STATUS_LABEL[status]}
    </span>
  );
}
