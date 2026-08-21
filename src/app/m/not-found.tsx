import Link from 'next/link';

export default function MechanicNotFound() {
  return (
    <main>
      <div className="card">
        <h2>No such job</h2>
        <p style={{ fontSize: 15, lineHeight: 1.55 }}>
          That code does not match a job in the system. Check the work order in your hand, or type
          its invoice number in by hand.
        </p>
        <Link className="btn navy block" href="/m" style={{ marginTop: 12 }}>
          Back to scanning
        </Link>
      </div>
    </main>
  );
}
