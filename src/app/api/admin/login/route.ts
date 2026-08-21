import { NextResponse, type NextRequest } from 'next/server';
import { checkAdminPassword, startAdminSession } from '@/lib/session';
import { config } from '@/lib/config';

/**
 * Plain form post so the portal still works with JavaScript off, and so a
 * wrong password is a page reload rather than a stuck spinner.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const password = typeof form.get('password') === 'string' ? (form.get('password') as string) : '';
  const next = typeof form.get('next') === 'string' ? (form.get('next') as string) : '/admin';

  if (!config.adminPassword) {
    return NextResponse.redirect(new URL('/admin/login?error=unset', request.url), 303);
  }
  if (!checkAdminPassword(password)) {
    return NextResponse.redirect(new URL('/admin/login?error=1', request.url), 303);
  }
  await startAdminSession();
  // Only ever bounce back inside this app.
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/admin';
  return NextResponse.redirect(new URL(target, request.url), 303);
}
