import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { authenticateByPin, getMechanic, setMechanicActive, setMechanicPin } from '@/lib/mechanics';

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const mechanic = getMechanic(id);
  if (!mechanic) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const action = str(form.get('action'));
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/admin/mechanics?${query}`, request.url), 303);

  if (action === 'deactivate') {
    setMechanicActive(mechanic.id, false);
    return back('saved=deactivated');
  }
  if (action === 'activate') {
    setMechanicActive(mechanic.id, true);
    return back('saved=activated');
  }
  if (action === 'reset_pin') {
    const pin = str(form.get('pin'));
    if (!pin || !/^\d{4,6}$/.test(pin)) return back('error=pin');
    const owner = authenticateByPin(pin);
    if (owner && owner.id !== mechanic.id) return back('error=pin_taken');
    setMechanicPin(mechanic.id, pin);
    return back('saved=pin');
  }
  return back('error=unknown');
}
