export default function TrackingNotFound() {
  return (
    <main className="wrap narrow" style={{ paddingTop: 60 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <h1 className="page-title">Link not found</h1>
        <p className="lead" style={{ margin: '10px auto 0' }}>
          That tracking link does not match a job. Check that you copied the whole link from your
          email, or call the shop and we will send it again.
        </p>
      </div>
    </main>
  );
}
