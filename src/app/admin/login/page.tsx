import { redirect } from 'next/navigation';
import { isAdmin } from '@/lib/session';
import { config } from '@/lib/config';

export const metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  '1': 'That password was not recognised.',
  unset: 'No admin password is configured on this server yet. Set ADMIN_PASSWORD and restart.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await isAdmin()) redirect('/admin');
  const { error, next } = await searchParams;

  return (
    <>
      <header className="tracker-head">
        <div className="inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/quest-mark.png" alt="" />
          <div>
            <div className="co">{config.shopName}</div>
            <div className="sub">Service writer portal</div>
          </div>
        </div>
      </header>
      <main className="wrap narrow">
        <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
          <h2>Sign in</h2>
          {error && <div className="banner warn">{ERRORS[error] ?? 'Sign-in failed.'}</div>}
          <form method="post" action="/api/admin/login">
            <input type="hidden" name="next" value={next ?? '/admin'} />
            <label className="fld" htmlFor="password">
              Portal password
            </label>
            <input
              className="txt"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
            />
            <div style={{ marginTop: 16 }}>
              <button className="btn navy block" type="submit">
                Sign in
              </button>
            </div>
          </form>
          <p className="hint" style={{ marginTop: 14 }}>
            Mechanics do not sign in here — they use the app on their phone and their PIN.
          </p>
        </div>
      </main>
    </>
  );
}
