// Mint a fresh signed "Pull listing" admin link (e.g. when the one in the booking DM expired).
// Usage: FEATURED_ADMIN_SECRET=… node scripts/featured-admin-link.mjs <listing-uuid> [hours=24]
// The secret is the same FEATURED_ADMIN_SECRET set on the Supabase functions. Prints the URL only (never the secret).
import { signAdminToken, adminUrl } from '../supabase/functions/_shared/featured-core.js';

const [id, hours = '24'] = process.argv.slice(2);
const secret = process.env.FEATURED_ADMIN_SECRET || '';
if (!id || !secret) { console.error('usage: FEATURED_ADMIN_SECRET=… node scripts/featured-admin-link.mjs <listing-id> [hours]'); process.exit(1); }
const h = Math.min(72, Math.max(1, Number(hours) || 24));
console.log(adminUrl(process.env.SITE_URL || 'https://maxigems.fun/', await signAdminToken({ id, exp: Date.now() + h * 3600000 }, secret)));
