import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <header className="tracker-head">
        <div className="inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/quest-mark.png" alt="" />
          <div>
            <div className="co">Quest Watersports</div>
            <div className="sub">Service Tracker</div>
          </div>
        </div>
      </header>
      <main className="wrap narrow">
        <h1 className="page-title">Shop tools</h1>
        <p className="lead">
          Work orders come out of BiT, get a QR code stamped on them here, and the shop logs against
          that same piece of paper. Customers follow along on the link they are emailed.
        </p>
        <div className="tiles">
          <Link className="tile" href="/admin">
            <b>Service writer portal</b>
            <span>
              Upload a work order, watch jobs move, attach the final invoice and payment link, mark
              a job done.
            </span>
          </Link>
          <Link className="tile" href="/m">
            <b>Mechanic app</b>
            <span>
              Scan the QR on the paper work order, log notes, parts and photos, mark the work
              finished.
            </span>
          </Link>
          <Link className="tile" href="/admin/setup">
            <b>Install on a phone</b>
            <span>One-time setup: add the mechanic app to a home screen so it opens like an app.</span>
          </Link>
        </div>
        <p className="lead" style={{ marginTop: 24 }}>
          Looking for your boat? Use the tracking link from your email — it opens your job directly,
          no login needed.
        </p>
      </main>
    </>
  );
}
