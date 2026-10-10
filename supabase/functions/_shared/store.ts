// Data access for the Pro functions. RestStore = PostgREST with the service role (inside Supabase only).
// MemoryStore = same contract in memory, used by the Deno tests (its fulfil() mirrors public.fulfil_order()).
// The featured branch extends both classes with its own listing methods.
// deno-lint-ignore-file no-explicit-any
import { DAY_MS } from './plans.js';

export type Row = Record<string, any>;
export interface Store {
  putNonce(r: Row): Promise<void>;
  getNonce(nonce: string): Promise<Row | null>;
  useNonce(nonce: string): Promise<boolean>; // true only for the first use
  upsertProfile(wallet: string): Promise<void>;
  getSub(wallet: string): Promise<Row | null>;
  allSubs(wallets: string[]): Promise<Row[]>;
  createOrder(r: Row): Promise<Row>;
  getOrder(id: string): Promise<Row | null>;
  pendingOrders(sinceIso: string, limit: number): Promise<Row[]>;
  touchOrder(id: string, patch: Row): Promise<void>;
  signatureUsed(sig: string): Promise<boolean>;
  fulfil(orderId: string, signature: string, paid: string): Promise<Row>;
  markFulfilled(orderId: string): Promise<void>;
  paidUnfulfilled(limit: number): Promise<Row[]>;
  getLink(wallet: string): Promise<Row | null>;
  getLinkByToken(token: string): Promise<Row | null>;
  getLinkByTg(tg: number): Promise<Row | null>;
  upsertLink(r: Row): Promise<void>;
  linksToCheck(): Promise<Row[]>;
  getFeed(key: string): Promise<Row | null>;
  putFeed(key: string, data: unknown): Promise<void>;
  audit(actor: string | null, action: string, detail: Row): Promise<void>;
}

export class RestStore implements Store {
  constructor(private url: string, private key: string, private f: typeof fetch = fetch) {}
  private async q(path: string, init: RequestInit = {}, prefer = ''): Promise<any> {
    const r = await this.f(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}), ...(init.headers || {}) },
    });
    const txt = await r.text();
    if (!r.ok) { const e: any = new Error(`db ${r.status}: ${txt.slice(0, 200)}`); e.status = r.status; e.body = txt; throw e; }
    return txt ? JSON.parse(txt) : null;
  }
  private one = async (path: string) => ((await this.q(path)) as Row[])[0] ?? null;
  private e = encodeURIComponent;
  async putNonce(r: Row) { await this.q('auth_nonces', { method: 'POST', body: JSON.stringify(r) }); }
  getNonce(n: string) { return this.one(`auth_nonces?nonce=eq.${this.e(n)}&select=*`); }
  async useNonce(n: string) { const r = await this.q(`auth_nonces?nonce=eq.${this.e(n)}&used_at=is.null`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) }, 'return=representation'); return r.length === 1; }
  async upsertProfile(w: string) { await this.q('profiles?on_conflict=wallet', { method: 'POST', body: JSON.stringify({ wallet: w, last_login_at: new Date().toISOString() }) }, 'resolution=merge-duplicates'); }
  getSub(w: string) { return this.one(`subscriptions?wallet=eq.${this.e(w)}&select=*`); }
  async allSubs(ws: string[]) { if (!ws.length) return []; return await this.q(`subscriptions?wallet=in.(${ws.map((w) => `"${w}"`).join(',')})&select=*`); }
  async createOrder(r: Row) { return (await this.q('orders', { method: 'POST', body: JSON.stringify(r) }, 'return=representation'))[0]; }
  getOrder(id: string) { return this.one(`orders?id=eq.${this.e(id)}&select=*`); }
  pendingOrders(since: string, limit: number) { return this.q(`orders?status=eq.pending&created_at=gte.${this.e(since)}&order=checked_at.asc.nullsfirst&limit=${limit}&select=*`); }
  async touchOrder(id: string, patch: Row) { await this.q(`orders?id=eq.${this.e(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); }
  async signatureUsed(sig: string) { return !!(await this.one(`orders?signature=eq.${this.e(sig)}&select=id`)); }
  async fulfil(o: string, s: string, p: string) { return await this.q('rpc/fulfil_order', { method: 'POST', body: JSON.stringify({ p_order: o, p_signature: s, p_paid: Number(p) }) }); }
  async markFulfilled(id: string) { await this.q('rpc/mark_order_fulfilled', { method: 'POST', body: JSON.stringify({ p_order: id }) }); }
  paidUnfulfilled(limit: number) { return this.q(`orders?status=eq.paid&fulfilled_at=is.null&order=paid_at.asc&limit=${limit}&select=*`); }
  getLink(w: string) { return this.one(`telegram_links?wallet=eq.${this.e(w)}&select=*`); }
  getLinkByToken(t: string) { return this.one(`telegram_links?token=eq.${this.e(t)}&select=*`); }
  getLinkByTg(tg: number) { return this.one(`telegram_links?tg_user_id=eq.${Number(tg)}&select=*`); }
  async upsertLink(r: Row) { await this.q('telegram_links?on_conflict=wallet', { method: 'POST', body: JSON.stringify(r) }, 'resolution=merge-duplicates'); }
  linksToCheck() { return this.q('telegram_links?tg_user_id=not.is.null&removed_at=is.null&select=*'); }
  getFeed(k: string) { return this.one(`pro_feed?key=eq.${this.e(k)}&select=*`); }
  async putFeed(k: string, data: unknown) { await this.q('pro_feed?on_conflict=key', { method: 'POST', body: JSON.stringify({ key: k, data, updated_at: new Date().toISOString() }) }, 'resolution=merge-duplicates'); }
  async audit(actor: string | null, action: string, detail: Row) { try { await this.q('audit_log', { method: 'POST', body: JSON.stringify({ actor, action, detail }) }); } catch { /* never block on audit */ } }
}

export class MemoryStore implements Store {
  nonces = new Map<string, Row>(); profiles = new Set<string>(); subs = new Map<string, Row>(); orders = new Map<string, Row>();
  links = new Map<string, Row>(); feed = new Map<string, Row>(); log: Row[] = [];
  now = () => Date.now();
  async putNonce(r: Row) { this.nonces.set(r.nonce, { ...r }); }
  async getNonce(n: string) { return this.nonces.get(n) ?? null; }
  async useNonce(n: string) { const r = this.nonces.get(n); if (!r || r.used_at) return false; r.used_at = new Date(this.now()).toISOString(); return true; }
  async upsertProfile(w: string) { this.profiles.add(w); }
  async getSub(w: string) { return this.subs.get(w) ?? null; }
  async allSubs(ws: string[]) { return ws.map((w) => this.subs.get(w)).filter(Boolean) as Row[]; }
  async createOrder(r: Row) { if ([...this.orders.values()].some((o) => o.reference === r.reference)) throw new Error('dup reference'); const o = { id: crypto.randomUUID(), status: 'pending', created_at: new Date(this.now()).toISOString(), ...r }; this.orders.set(o.id, o); return { ...o }; }
  async getOrder(id: string) { const o = this.orders.get(id); return o ? { ...o } : null; }
  async pendingOrders(since: string, limit: number) { return [...this.orders.values()].filter((o) => o.status === 'pending' && o.created_at >= since).slice(0, limit); }
  async touchOrder(id: string, p: Row) { Object.assign(this.orders.get(id)!, p); }
  async signatureUsed(sig: string) { return [...this.orders.values()].some((o) => o.signature === sig); }
  async fulfil(id: string, sig: string, paid: string) {
    const o = this.orders.get(id); const now = this.now();
    if (!o) return { ok: false, error: 'no_order' };
    if (o.status === 'paid') return { ok: o.signature === sig, already: true, kind: o.kind, fulfilled: !!o.fulfilled_at, error: o.signature === sig ? null : 'order_already_paid' };
    if ([...this.orders.values()].some((x) => x.signature === sig)) throw Object.assign(new Error('db 409: duplicate key orders_signature_key'), { status: 409 });
    if (BigInt(paid) < BigInt(o.lamports)) return { ok: false, error: 'short_amount' };
    Object.assign(o, { status: 'paid', signature: sig, paid_lamports: paid, paid_at: new Date(now).toISOString() });
    if (o.kind === 'pro') {
      const cur = this.subs.get(o.wallet);
      const base = Math.max(now, cur ? Date.parse(cur.expires_at) : 0);
      const exp = new Date(base + o.days * DAY_MS).toISOString();
      this.subs.set(o.wallet, { wallet: o.wallet, plan: o.plan, expires_at: exp });
      const l = this.links.get(o.wallet); if (l) l.removed_at = null;
      o.fulfilled_at = new Date(now).toISOString();
      return { ok: true, kind: 'pro', fulfilled: true, expires_at: exp };
    }
    return { ok: true, kind: o.kind, fulfilled: false };
  }
  async markFulfilled(id: string) { const o = this.orders.get(id); if (o && o.status === 'paid' && !o.fulfilled_at) o.fulfilled_at = new Date(this.now()).toISOString(); }
  async paidUnfulfilled(limit: number) { return [...this.orders.values()].filter((o) => o.status === 'paid' && !o.fulfilled_at).slice(0, limit); }
  async getLink(w: string) { return this.links.get(w) ?? null; }
  async getLinkByToken(t: string) { return [...this.links.values()].find((l) => l.token === t) ?? null; }
  async getLinkByTg(tg: number) { return [...this.links.values()].find((l) => l.tg_user_id === tg) ?? null; }
  async upsertLink(r: Row) { this.links.set(r.wallet, { ...(this.links.get(r.wallet) ?? {}), ...r }); }
  async linksToCheck() { return [...this.links.values()].filter((l) => l.tg_user_id && !l.removed_at); }
  async getFeed(k: string) { return this.feed.get(k) ?? null; }
  async putFeed(k: string, data: unknown) { this.feed.set(k, { key: k, data, updated_at: new Date(this.now()).toISOString() }); }
  async audit(actor: string | null, action: string, detail: Row) { this.log.push({ actor, action, detail }); }
}
