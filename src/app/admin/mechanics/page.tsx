import { AdminChrome } from '@/components/AdminChrome';
import { formatDate } from '@/lib/format';
import { listMechanics } from '@/lib/mechanics';
import { requireAdminPage } from '@/lib/page-guards';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Mechanics' };

const NOTICES: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
  'saved=created': { tone: 'ok', text: 'Added to the roster.' },
  'saved=renamed': { tone: 'ok', text: 'Name changed. Everything they logged stays theirs.' },
  'saved=deactivated': {
    tone: 'ok',
    text: 'Switched off — that name can no longer sign in on the shop floor.',
  },
  'saved=activated': { tone: 'ok', text: 'Switched back on.' },
  'error=name': { tone: 'warn', text: 'Enter a name the way the shop would write it.' },
  'error=name_taken': {
    tone: 'warn',
    text: 'Somebody on the roster already goes by that name. The log has to stay unambiguous about who did what.',
  },
};

export default async function MechanicsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminPage('/admin/mechanics');
  const query = await searchParams;
  const key = query.saved ? `saved=${query.saved}` : query.error ? `error=${query.error}` : null;
  const notice = key ? NOTICES[key] : null;
  const mechanics = listMechanics(true);

  return (
    <AdminChrome active="mechanics">
      <main className="wrap narrow">
        <h1 className="page-title">Mechanics</h1>
        <p className="lead">
          Names on this list are the buttons the shop floor taps to sign in. Nobody has a password
          or a PIN — a mechanic who types a name that is not here yet joins the list on the spot,
          so this is the roster describing the shop, not a gate in front of it.
        </p>

        {notice && <div className={`banner ${notice.tone}`}>{notice.text}</div>}

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Roster</h2>
          {mechanics.length === 0 ? (
            <div className="empty">
              Nobody yet. Add the crew below so they have a name to tap, or let the first person to
              open a job type theirs.
            </div>
          ) : (
            <div className="stack">
              {mechanics.map((mechanic) => (
                <div
                  key={mechanic.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    background: mechanic.active ? '#fff' : '#fafbfc',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <b style={{ color: 'var(--navy)' }}>{mechanic.name}</b>
                      <div className="hint">Added {formatDate(mechanic.created_at)}</div>
                    </div>
                    <div className="row tight">
                      <span className={`pill ${mechanic.active ? 'green' : 'grey'}`}>
                        {mechanic.active ? 'Active' : 'Switched off'}
                      </span>
                      <form method="post" action={`/api/admin/mechanics/${mechanic.id}`}>
                        <input
                          type="hidden"
                          name="action"
                          value={mechanic.active ? 'deactivate' : 'activate'}
                        />
                        <button className="btn ghost sm" type="submit">
                          {mechanic.active ? 'Switch off' : 'Switch on'}
                        </button>
                      </form>
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/api/admin/mechanics/${mechanic.id}`}
                    className="row tight"
                    style={{ marginTop: 10, flexWrap: 'nowrap' }}
                  >
                    <input type="hidden" name="action" value="rename" />
                    <input
                      className="txt"
                      name="name"
                      defaultValue={mechanic.name}
                      aria-label={`Rename ${mechanic.name}`}
                    />
                    <button className="btn ghost sm" type="submit">
                      Rename
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Add someone</h2>
          <form method="post" action="/api/admin/mechanics">
            <label className="fld" htmlFor="name">
              Name
            </label>
            <input className="txt" id="name" name="name" autoComplete="off" required />
            <p className="hint">
              Spell it the way it should read on a job. Whatever you put here is what they tap.
            </p>
            <button className="btn navy" type="submit" style={{ marginTop: 12 }}>
              Add to roster
            </button>
          </form>
        </section>
      </main>
    </AdminChrome>
  );
}
