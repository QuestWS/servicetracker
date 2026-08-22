import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/lib/guards';
import { listMechanics, signInByName } from '@/lib/mechanics';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import { currentMechanic, startMechanicSession } from '@/lib/session';

/**
 * Who is signed in on this device, plus the roster to tap from — typing a
 * name on the shop iPad is slower than picking it, and picking it also means
 * the name is spelled the same way every time.
 */
export async function GET() {
  return NextResponse.json({
    mechanic: await currentMechanic(),
    roster: listMechanics().map((m) => ({ id: m.id, name: m.name })),
  });
}

export async function POST(request: NextRequest) {
  // Not a guard on the log — there is no secret to guess — but it stops
  // anyone filling the roster with junk names faster than a person could.
  if (!rateLimit(clientKey(request, 'signin'), 30, 5 * 60 * 1000)) {
    return jsonError('Too many sign-ins from here. Wait a few minutes.', 429);
  }

  const body = (await request.json().catch(() => null)) as
    | { name?: string; remember?: boolean }
    | null;
  const name = (body?.name ?? '').trim();
  if (!name) return jsonError('Enter your name.', 400);

  const result = signInByName(name);
  if (!result.ok) {
    return jsonError(
      result.reason === 'inactive'
        ? 'That name is switched off in the office. Ask the service writer.'
        : 'Use your name as the shop would write it on the schedule.',
      result.reason === 'inactive' ? 403 : 400,
    );
  }

  await startMechanicSession(
    { id: result.mechanic.id, name: result.mechanic.name },
    body?.remember !== false,
  );
  return NextResponse.json({
    mechanic: { id: result.mechanic.id, name: result.mechanic.name },
    created: result.created,
  });
}
