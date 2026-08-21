export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main>
      <div className="card">
        <h2>No connection</h2>
        <p style={{ fontSize: 15, lineHeight: 1.55 }}>
          The app opened, but it cannot reach the shop server right now. Notes are never saved on
          the phone — so nothing has been lost, and nothing has been sent either. Get back into wifi
          or cell service and try again.
        </p>
      </div>
    </main>
  );
}
