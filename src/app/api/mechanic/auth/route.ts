import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/lib/guards';
import { authenticateByPin } from '@/lib/mechanics';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import { currentMechanic, startMechanicSession } from '@/lib/session';

export async function GET() {
  const mechanic = await currentMechanic();
  return NextResponse.json({ mechanic });
}

export async function POST(request: NextRequest) {
  if (!rateLimit(clientKey(request, 'pin'), 10, 5 * 60 * 1000)) {
    return jsonError('Too many attempts. Wait a few minutes and try again.', 429);
  }
  const body = (await request.json().catch(() => null)) as { pin?: string } | null;
  const pin = (body?.pin ?? '').trim();
  if (!/^\d{4,6}$/.test(pin)) return jsonError('Enter your PIN.', 400);

  const mechanic = authenticateByPin(pin);
  if (!mechanic) return jsonError('That PIN was not recognised.', 401);

  await startMechanicSession({ id: mechanic.id, name: mechanic.name });
  return NextResponse.json({ mechanic: { id: mechanic.id, name: mechanic.name } });
}
