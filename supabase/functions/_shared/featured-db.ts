// Featured listings data access. RestFeatured = PostgREST + the featured_book/featured_pull RPCs (service role, inside
// Supabase only). MemoryFeatured = same contract in memory for the Deno tests (book() mirrors public.featured_book()).
// Attached to the shared store as `store.featured` so the Pro store files stay untouched.
// deno-lint-ignore-file no-explicit-any
import { schedule, FEATURED_RULES } from './featured-core.js';

export type Row = Record<string, any>;
export type BookParams = { ca: string; symbol: string; orderId: string; wallet: string; token: Row; safety: Row; now: number };
export interface FeaturedDb {
  listings(sinceIso: string): Promise<Row[]>;
  get(id: string): Promise<Row | null>;
  byOrder(orderId: string): Promise<Row | null>;
  latestForCa(ca: string): Promise<Row | null>;
  book(p: BookParams): Promise<Row>; // {ok, already?, listing?, error?}
  pull(id: string, by: string, reason?: string): Promise<Row>;
  patch(id: string, body: Row): Promise<void>;
}

export class RestFeatured implements FeaturedDb {
  constructor(private url: string, private key: string, private f: typeof fetch = fetch) {}
  private async q(path: string, init: RequestInit = {}): Promise<any> {
    const r = await this.f(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json', prefer: 'return=representation', ...(init.headers || {}) },
    });
    const txt = await r.text();
    if (!r.ok) throw Object.assign(new Error(`db ${r.status}: ${txt.slice(0, 200)}`), { status: r.status });
    return txt ? JSON.parse(txt) : null;
  }
  private e = encodeURIComponent;
  listings(since: string) { return this.q(`featured_listings?ends_at=gte.${this.e(since)}&order=starts_at.asc&limit=500&select=*`); }
  async get(id: string) { return (await this.q(`featured_listings?id=eq.${this.e(id)}&select=*`))[0] ?? null; }
  async byOrder(id: string) { return (await this.q(`featured_listings?order_id=eq.${this.e(id)}&select=*`))[0] ?? null; }
  async latestForCa(ca: string) { return (await this.q(`featured_listings?ca=eq.${this.e(ca)}&order=created_at.desc&limit=1&select=*`))[0] ?? null; }
  book(p: BookParams) {
    return this.q('rpc/featured_book', { method: 'POST', body: JSON.stringify({
      p_ca: p.ca, p_symbol: p.symbol, p_order_id: p.orderId, p_wallet: p.wallet, p_token: p.token, p_safety: p.safety,
      p_now: new Date(p.now).toISOString(), p_hours: FEATURED_RULES.hours, p_max_concurrent: FEATURED_RULES.maxConcurrent,
      p_posts_per_day: FEATURED_RULES.maxPostsPerDay, p_post_lead: `${FEATURED_RULES.postLeadMs / 1000} seconds`,
    }) });
  }
  pull(id: string, by: string, reason?: string) { return this.q('rpc/featured_pull', { method: 'POST', body: JSON.stringify({ p_id: id, p_by: by, p_reason: reason ?? null }) }); }
  async patch(id: string, body: Row) { await this.q(`featured_listings?id=eq.${this.e(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); }
}

export class MemoryFeatured implements FeaturedDb {
  rows: Row[] = [];
  async listings(since: string) { return this.rows.filter((r) => r.ends_at >= since).map((r) => ({ ...r })); }
  async get(id: string) { const r = this.rows.find((x) => x.id === id); return r ? { ...r } : null; }
  async byOrder(id: string) { const r = this.rows.find((x) => x.order_id === id); return r ? { ...r } : null; }
  async latestForCa(ca: string) { const r = this.rows.filter((x) => x.ca === ca).at(-1); return r ? { ...r } : null; }
  async book(p: BookParams) {
    const ex = this.rows.find((r) => r.order_id === p.orderId);
    if (ex) return { ok: true, already: true, listing: { ...ex } };
    for (const r of this.rows) if ((r.status === 'queued' || r.status === 'active') && Date.parse(r.ends_at) <= p.now) r.status = 'ended';
    if (this.rows.some((r) => r.ca === p.ca && (r.status === 'queued' || r.status === 'active'))) return { ok: false, error: 'already_featured' };
    const q = schedule(this.rows, p.now);
    const row = {
      id: crypto.randomUUID(), ca: p.ca, symbol: p.symbol.slice(0, 16), order_id: p.orderId, wallet: p.wallet,
      starts_at: q.startsAt, ends_at: q.endsAt, post_due_at: q.postDueAt, status: Date.parse(q.startsAt) <= p.now ? 'active' : 'queued',
      posted_at: null, post_message_id: null, token: p.token, safety: p.safety, created_at: new Date(p.now).toISOString(),
    };
    this.rows.push(row);
    return { ok: true, listing: { ...row } };
  }
  async pull(id: string, by: string, reason?: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.status === 'queued' || r.status === 'active') { Object.assign(r, { status: 'pulled', pulled_at: new Date().toISOString(), pulled_by: by, pull_reason: reason ?? null }); return { ok: true, listing: { ...r } }; }
    return { ok: r.status === 'pulled', already: true, listing: { ...r }, error: r.status === 'pulled' ? null : 'not_live' };
  }
  async patch(id: string, body: Row) { const r = this.rows.find((x) => x.id === id); if (r) Object.assign(r, body); }
}

/** The featured DB for these deps: store.featured if present (tests), else PostgREST with the function's service role. */
export function featuredDb(d: { store: any; fetch: typeof fetch }): FeaturedDb {
  if (d.store.featured) return d.store.featured;
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  d.store.featured = new RestFeatured(url, key, d.fetch);
  return d.store.featured;
}
