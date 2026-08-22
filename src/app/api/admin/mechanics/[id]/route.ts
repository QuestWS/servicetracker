import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { getMechanic, renameMechanic, setMechanicActive } from '@/lib/mechanics';

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
  if (action === 'rename') {
    // Renaming keeps every entry they have already logged attached to them —
    // the log points at the row, not at the spelling.
    const name = str(form.get('name'));
    if (!name) return back('error=name');
    return back(renameMechanic(mechanic.id, name) ? 'saved=renamed' : 'error=name_taken');
  }
  return back('error=unknown');
}
