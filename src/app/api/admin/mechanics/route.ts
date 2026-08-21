import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { authenticateByPin, createMechanic, listMechanics } from '@/lib/mechanics';

function isPin(value: string | null): value is string {
  return Boolean(value && /^\d{4,6}$/.test(value));
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const form = await request.formData();
  const name = str(form.get('name'));
  const pin = str(form.get('pin'));
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/admin/mechanics?${query}`, request.url), 303);

  if (!name) return back('error=name');
  if (!isPin(pin)) return back('error=pin');
  // Two people with the same PIN would make the log ambiguous about who
  // logged what, so the PIN has to be unique across the active roster.
  if (authenticateByPin(pin)) return back('error=pin_taken');
  if (listMechanics(true).some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    return back('error=name_taken');
  }

  createMechanic(name, pin);
  return back('saved=created');
}
