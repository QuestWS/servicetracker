import Link from 'next/link';

/** The service writer's shell: same navy bar and gold rule as the console. */
export function AdminChrome({
  active,
  children,
}: {
  active?: 'jobs' | 'intake' | 'mechanics' | 'setup';
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="mark" src="/quest-mark.png" alt="" />
        <div className="ttl">
          Service Tracker
          <small>Quest Watersports · Ottawa, IL</small>
        </div>
        <div className="spacer" />
        <nav>
          <Link className={`linkbtn${active === 'jobs' ? ' on' : ''}`} href="/admin">
            Jobs
          </Link>
          <Link className={`linkbtn${active === 'intake' ? ' on' : ''}`} href="/admin/intake">
            New work order
          </Link>
          <Link className={`linkbtn${active === 'mechanics' ? ' on' : ''}`} href="/admin/mechanics">
            Mechanics
          </Link>
          <Link className={`linkbtn${active === 'setup' ? ' on' : ''}`} href="/admin/setup">
            App setup
          </Link>
          <form action="/api/admin/logout" method="post">
            <button className="linkbtn" type="submit">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      {children}
    </>
  );
}
