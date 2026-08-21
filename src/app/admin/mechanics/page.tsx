import { AdminChrome } from '@/components/AdminChrome';
import { PinField } from '@/components/PinField';
import { formatDate } from '@/lib/format';
import { listMechanics } from '@/lib/mechanics';
import { requireAdminPage } from '@/lib/page-guards';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Mechanics' };

const NOTICES: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
  'saved=created': { tone: 'ok', text: 'Mechanic added. Tell them their PIN in person.' },
  'saved=pin': { tone: 'ok', text: 'PIN changed.' },
  'saved=deactivated': { tone: 'ok', text: 'Mechanic deactivated — their PIN no longer works.' },
  'saved=activated': { tone: 'ok', text: 'Mechanic reactivated.' },
  'error=name': { tone: 'warn', text: 'Enter a name.' },
  'error=name_taken': { tone: 'warn', text: 'Someone on the roster already has that name.' },
  'error=pin': { tone: 'warn', text: 'A PIN must be 4 to 6 digits.' },
  'error=pin_taken': {
    tone: 'warn',
    text: 'That PIN belongs to someone else. Two people sharing a PIN would make the log ambiguous.',
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
          A PIN is how the app knows whose note it is. Nobody signs in with an email address and
          nobody types a password on the shop floor.
        </p>

        {notice && <div className={`banner ${notice.tone}`}>{notice.text}</div>}

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Roster</h2>
          {mechanics.length === 0 ? (
            <div className="empty">Nobody on the roster yet. Add the first mechanic below.</div>
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
                        {mechanic.active ? 'Active' : 'Inactive'}
                      </span>
                      <form method="post" action={`/api/admin/mechanics/${mechanic.id}`}>
                        <input
                          type="hidden"
                          name="action"
                          value={mechanic.active ? 'deactivate' : 'activate'}
                        />
                        <button className="btn ghost sm" type="submit">
                          {mechanic.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </form>
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/api/admin/mechanics/${mechanic.id}`}
                    style={{ marginTop: 10 }}
                  >
                    <input type="hidden" name="action" value="reset_pin" />
                    <PinField id={`pin-${mechanic.id}`} label="Set a new PIN" />
                    <button className="btn ghost sm" type="submit" style={{ marginTop: 10 }}>
                      Change PIN
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Add a mechanic</h2>
          <form method="post" action="/api/admin/mechanics">
            <label className="fld" htmlFor="name">
              Name
            </label>
            <input className="txt" id="name" name="name" required />
            <PinField />
            <p className="hint">
              Write it down for them once and hand it over — the PIN is stored hashed and cannot be
              looked up later, only replaced.
            </p>
            <button className="btn navy" type="submit" style={{ marginTop: 12 }}>
              Add mechanic
            </button>
          </form>
        </section>
      </main>
    </AdminChrome>
  );
}
