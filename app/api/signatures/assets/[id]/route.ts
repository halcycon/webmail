import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { verifyAccountIdentity } from '@/lib/auth/verify-account-identity';
import {
  SignatureAssetError,
  loadSignatureAsset,
  deleteSignatureAsset,
} from '@/lib/signature-assets';

function classifyAssetError(error: unknown): { message: string; status: number } {
  if (error instanceof SignatureAssetError) {
    switch (error.code) {
      case 'not_configured':
        return { message: error.message, status: 503 };
      case 'invalid_identity':
      case 'invalid_asset_id':
      case 'invalid_mime':
      case 'too_large':
      case 'too_many':
        return { message: error.message, status: 400 };
      case 'not_found':
        return { message: error.message, status: 404 };
      case 'forbidden':
        return { message: error.message, status: 403 };
      case 'path':
        return { message: 'Invalid request', status: 400 };
    }
  }
  const msg = error instanceof Error ? error.message : 'Unknown error';
  return { message: `Internal server error: ${msg}`, status: 500 };
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/signatures/assets/:id
 * Authenticated fetch of asset bytes for the composer / identity editor.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  if (!hasSessionSecret()) {
    return NextResponse.json(
      { error: 'Signature image storage requires SESSION_SECRET' },
      { status: 503 },
    );
  }

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  if (!username || !serverUrl) {
    return NextResponse.json({ error: 'Missing identity headers' }, { status: 400 });
  }

  const accountName = await verifyAccountIdentity(username, serverUrl);
  if (!accountName) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const { id } = await context.params;
    const { asset, bytes } = await loadSignatureAsset(accountName, serverUrl, id);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': asset.mimeType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${asset.filename.replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const classified = classifyAssetError(error);
    if (classified.status >= 500) {
      logger.error('Signature asset fetch error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}

/**
 * DELETE /api/signatures/assets/:id
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  if (!hasSessionSecret()) {
    return NextResponse.json(
      { error: 'Signature image storage requires SESSION_SECRET' },
      { status: 503 },
    );
  }

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  if (!username || !serverUrl) {
    return NextResponse.json({ error: 'Missing identity headers' }, { status: 400 });
  }

  const accountName = await verifyAccountIdentity(username, serverUrl);
  if (!accountName) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const { id } = await context.params;
    await deleteSignatureAsset(accountName, serverUrl, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const classified = classifyAssetError(error);
    if (classified.status >= 500) {
      logger.error('Signature asset delete error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
