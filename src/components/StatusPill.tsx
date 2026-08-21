import { STATUS_PILL, STATUS_SHORT, STATUS_LABEL, type Status } from '@/lib/status';

export function StatusPill({ status, full = false }: { status: Status; full?: boolean }) {
  return (
    <span className={`pill ${STATUS_PILL[status]}`}>
      {full ? STATUS_LABEL[status] : STATUS_SHORT[status]}
    </span>
  );
}
