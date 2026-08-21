import { AdminChrome } from '@/components/AdminChrome';
import { requireAdminPage } from '@/lib/page-guards';
import { IntakeForm } from './IntakeForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New work order' };

export default async function IntakePage() {
  await requireAdminPage('/admin/intake');
  return (
    <AdminChrome active="intake">
      <main className="wrap narrow">
        <h1 className="page-title">New work order</h1>
        <p className="lead">
          Upload the work order you just downloaded from BiT. We read the invoice number, customer
          and unit off it, create the job, and hand back the same document with a QR code added —
          print that copy and the shop floor works exactly as it does today.
        </p>
        <IntakeForm />
      </main>
    </AdminChrome>
  );
}
