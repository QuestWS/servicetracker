import Link from 'next/link';
import { ServiceWorkerRegister } from './components/ServiceWorkerRegister';

export const metadata = {
  title: 'Quest Shop',
  robots: { index: false, follow: false },
};

export default function MechanicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mech">
      <ServiceWorkerRegister />
      <div className="mech-top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/quest-mark.png" alt="" style={{ height: 30, borderRadius: 6 }} />
        <Link href="/m" style={{ textDecoration: 'none', color: '#fff' }}>
          <div className="t">Quest Shop</div>
        </Link>
      </div>
      {children}
    </div>
  );
}
