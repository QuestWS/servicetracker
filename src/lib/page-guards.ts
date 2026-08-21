import { redirect } from 'next/navigation';
import { isAdmin } from './session';

/** Page-level guard: bounce to the login form, remembering where we were. */
export async function requireAdminPage(next: string): Promise<void> {
  if (!(await isAdmin())) {
    redirect(`/admin/login?next=${encodeURIComponent(next)}`);
  }
}
