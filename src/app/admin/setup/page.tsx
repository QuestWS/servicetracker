import { AdminChrome } from '@/components/AdminChrome';
import { CopyField } from '@/components/CopyField';
import { config } from '@/lib/config';
import { requireAdminPage } from '@/lib/page-guards';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App setup' };

export default async function SetupPage() {
  await requireAdminPage('/admin/setup');
  const appUrl = `${config.appUrl}/m`;

  return (
    <AdminChrome active="setup">
      <main className="wrap narrow">
        <h1 className="page-title">Put the app on a phone</h1>
        <p className="lead">
          Do this once per phone or iPad. After it is on the home screen, the daily routine is: tap
          the icon, scan the work order, tap your name.
        </p>

        <section className="card">
          <h2>Step 1 — open this on the phone</h2>
          <div style={{ textAlign: 'center', padding: '10px 0 16px' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/api/admin/setup-qr"
              alt={`QR code linking to ${appUrl}`}
              width={220}
              height={220}
              style={{ border: '1px solid var(--line)', borderRadius: 12, background: '#fff' }}
            />
          </div>
          <p className="hint" style={{ textAlign: 'center', marginBottom: 14 }}>
            Point the phone&apos;s normal camera at this code — no app needed yet.
          </p>
          <CopyField label="Or type this address" value={appUrl} />
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Step 2 — add it to the home screen</h2>
          <div className="grid2">
            <div>
              <b style={{ color: 'var(--navy)' }}>iPhone / iPad (Safari)</b>
              <ol style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 14.5, lineHeight: 1.6 }}>
                <li>Tap the Share button (the square with the arrow).</li>
                <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
                <li>Tap <b>Add</b>. The Quest icon appears with the other apps.</li>
              </ol>
              <p className="hint">
                It must be Safari — the Share sheet in Chrome on iOS does not offer this.
              </p>
            </div>
            <div>
              <b style={{ color: 'var(--navy)' }}>Android (Chrome)</b>
              <ol style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 14.5, lineHeight: 1.6 }}>
                <li>Tap the ⋮ menu, top right.</li>
                <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li>
                <li>Confirm. The Quest icon appears in the app drawer.</li>
              </ol>
              <p className="hint">Chrome often offers this by itself as a bar at the bottom.</p>
            </div>
          </div>
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Step 3 — check the camera works</h2>
          <p style={{ fontSize: 15, lineHeight: 1.55 }}>
            Open the app from the home screen and tap <b>Scan work order</b>. The phone asks for
            camera permission the first time — say yes. If someone taps &ldquo;don&apos;t
            allow&rdquo; by mistake, the app still works: the <b>Type invoice number instead</b>{' '}
            button is right on the same screen, and camera permission can be re-enabled in the
            phone&apos;s settings for this site.
          </p>
        </section>
      </main>
    </AdminChrome>
  );
}
