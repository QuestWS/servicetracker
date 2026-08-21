import { NextResponse, type NextRequest } from 'next/server';
import { endAdminSession } from '@/lib/session';

export async function POST(request: NextRequest) {
  await endAdminSession();
  return NextResponse.redirect(new URL('/admin/login', request.url), 303);
}
