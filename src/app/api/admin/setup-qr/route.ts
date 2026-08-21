import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/guards';
import { config } from '@/lib/config';
import { qrPng } from '@/lib/pdf/stamp';

export const runtime = 'nodejs';

/**
 * The one-time onboarding code. A mechanic scans this once with their phone
 * camera, lands on the install page, and adds the app to their home screen —
 * after that they never type a URL or scan anything but work orders.
 */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const png = await qrPng(`${config.appUrl}/m`, 10);
  return new NextResponse(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=600',
      'Content-Disposition': 'inline; filename="quest-shop-app.png"',
    },
  });
}
