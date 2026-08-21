import { NextResponse } from 'next/server';
import { endMechanicSession } from '@/lib/session';

export async function POST() {
  await endMechanicSession();
  return NextResponse.json({ ok: true });
}
