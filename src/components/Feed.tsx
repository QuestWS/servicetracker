import { ENTRY_LABEL, type LogEntryView } from '@/lib/entry-types';
import { formatDateTime } from '@/lib/format';

function Photos({ photos }: { photos: LogEntryView['photos'] }) {
  if (!photos.length) return null;
  return (
    <div className="photos">
      {photos.map((photo) => (
        <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt="Job photo" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function Body({ entry }: { entry: LogEntryView }) {
  if (entry.text) return <div className="body">{entry.text}</div>;
  if (entry.transcript_status === 'pending') {
    return <div className="body pending">Voice note — transcribing…</div>;
  }
  if (entry.transcript_status === 'failed') {
    return (
      <div className="body pending">
        Voice note — transcription failed{entry.transcript_error ? ` (${entry.transcript_error})` : ''}. The
        recording is below.
      </div>
    );
  }
  return null;
}

/** The full shop-side log: notes, parts, photos and audio in one stream. */
export function ShopFeed({ entries }: { entries: LogEntryView[] }) {
  if (!entries.length) {
    return <div className="empty">Nothing logged yet. Entries appear here as mechanics add them.</div>;
  }
  return (
    <div className="feed">
      {entries.map((entry) => (
        <article key={entry.id} className={`entry ${entry.entry_type}`}>
          <div className="meta">
            <span className={`pill ${entry.entry_type === 'part' ? 'gold' : entry.entry_type === 'customer_note' ? 'green' : 'blue'}`}>
              {ENTRY_LABEL[entry.entry_type]}
            </span>
            <span>{entry.mechanic_name ?? 'Unknown'}</span>
            <span>·</span>
            <time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>
          </div>
          {entry.entry_type === 'part' && (
            <div className="partline">
              {entry.part_identifier ?? '(no identifier)'}
              {entry.quantity ? ` × ${entry.quantity}` : ''}
            </div>
          )}
          <Body entry={entry} />
          {entry.audio_url && <audio controls preload="none" src={entry.audio_url} />}
          <Photos photos={entry.photos} />
        </article>
      ))}
    </div>
  );
}

/**
 * The customer's feed. It is handed only customer-note entries — the filter
 * lives in the query, not here — and shows no author, no parts, no pricing.
 */
export function CustomerFeed({ entries }: { entries: LogEntryView[] }) {
  if (!entries.length) {
    return (
      <div className="empty">
        No updates posted yet. Anything the shop wants you to see will show up here.
      </div>
    );
  }
  return (
    <div className="feed">
      {entries.map((entry) => (
        <article key={entry.id} className="entry customer_note">
          <div className="meta">
            <time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>
          </div>
          {entry.text && <div className="body">{entry.text}</div>}
          <Photos photos={entry.photos} />
        </article>
      ))}
    </div>
  );
}
