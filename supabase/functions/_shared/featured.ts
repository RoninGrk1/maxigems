// FEATURED LISTINGS HOOKS — owned by the featured worker (branch 'featured'). This file is a STUB on 'pro'.
// Contract (see CONTRACT.md). All hooks receive the same Deps as every handler ({store, env, fetch, now}).
// deno-lint-ignore-file no-explicit-any require-await
import type { Deps } from './app.ts';

export type FeaturedValidation =
  | { ok: true; meta: Record<string, unknown> }               // meta is stored on orders.meta (symbol, name, image, safety…)
  | { ok: false; status: number; error: string; reasons?: string[] };

/** create-order (kind 'featured'): server-side RugCheck gate + caps. Must fail closed. STUB: always rejects. */
export async function validateFeaturedOrder(_ca: string, _d: Deps, _wallet?: string): Promise<FeaturedValidation> {
  return { ok: false, status: 501, error: 'Featured listings aren’t available yet.' };
}

/**
 * verify-payment / sweep: called once the order is PAID on-chain (orders.status='paid', fulfilled_at null).
 * Must be idempotent per order.id (it can be retried by the sweep). Return ok:true to set orders.fulfilled_at.
 * STUB: never fulfils.
 */
export async function fulfilFeatured(_d: Deps, _order: Record<string, any>, _signature: string): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  return { ok: false, error: 'featured_not_implemented' };
}

/** telegram webhook: callback_query from the admin (e.g. 'pull:<id>'). Return true when handled. STUB: not handled. */
export async function handleFeaturedCallback(_d: Deps, _cq: any): Promise<boolean> {
  return false;
}

/** sweep (every ~2 min): featured lifecycle + the sponsored post. Return counters to merge in the sweep output. STUB. */
export async function sweepFeatured(_d: Deps): Promise<Record<string, number>> {
  return {};
}
