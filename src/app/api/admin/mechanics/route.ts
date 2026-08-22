import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { createMechanic, findMechanicByName, isUsableName, normalizeName } from '@/lib/mechanics';

/**
 * Adding someone here is a convenience, not a gate: a mechanic who types a
 * name nobody has used before joins the roster on the spot. What this screen
 * really controls is the list they tap from, and who is switched off.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const form = await request.formData();
  const name = normalizeName(str(form.get('name')) ?? '');
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/admin/mechanics?${query}`, request.url), 303);

  if (!isUsableName(name)) return back('error=name');
  // One name, one person — the log has to stay unambiguous about who logged
  // what, and the name is the whole of the identity now.
  if (findMechanicByName(name)) return back('error=name_taken');

  createMechanic(name);
  return back('saved=created');
}
