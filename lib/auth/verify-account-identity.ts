import { cookies } from 'next/headers';
import { decryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

/** Strip trailing slashes so differently-formatted URLs still match. */
export function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Verify identity against session cookies across all account slots.
 * With multi-account, the requesting account may be on any slot.
 * Checks both basic-auth session cookies and stalwart auth context cookies
 * (used by OAuth/SSO and TOTP-upgraded sessions).
 * Returns the account name to key per-account storage on, or null when no
 * cookie matches. That is the cookie's `accountName` when it has one: a
 * Bearer login claimed with a bare local part must not share `john`'s data
 * with every other `john` on a multi-domain server.
 */
export async function verifyAccountIdentity(
  username: string,
  serverUrl: string,
): Promise<string | null> {
  const cookieStore = await cookies();
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const token = cookieStore.get(sessionCookieName(slot))?.value;
    if (token) {
      const session = decryptSession(token);
      if (
        session &&
        session.username === username &&
        normalizeServerUrl(session.serverUrl) === normalizedServerUrl
      ) {
        return username;
      }
    }

    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (
      ctx &&
      ctx.username === username &&
      normalizeServerUrl(ctx.serverUrl) === normalizedServerUrl
    ) {
      return ctx.accountName ?? username;
    }
  }

  return null;
}
