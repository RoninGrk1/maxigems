// ── MaxiGems site config: edit ONLY here ──────────────────────────
window.MAXIGEMS_CONFIG = {
  telegramUrl: 'https://t.me/maxigems_calls', // ← your channel link
  chatUrl: 'https://t.me/MGcalls_gc',          // ← discussion group link
  xUrl: 'https://x.com/maxigems_sol',          // ← X / Twitter profile ('' hides the buttons)
  dataUrl: '/data/calls.json',
  refreshSeconds: 60,
  // SOL tip address (site tip card, footer link, coin pages). After changing it run: npm run build:tip
  tipAddress: '2vrom1iH7Fr3fCJwfQvg9tCL5Y1n6EVpLn7zyqdnJfwD',
  // ── MaxiGems Pro + Featured (shared payments core; see CONTRACT.md) ──
  // Display values only: the Edge Functions price every order server-side. After changing treasury run: npm run build:pay
  proApi: 'https://wrlsgqfpcvdjzsueikxw.supabase.co/functions/v1',
  treasury: '9dw32avaHbCsySNJNrwreV5onRTUubMpq88tp5XMwLMX', // subscription/featured payments (NOT the tip address)
  proPrices: { 30: 0.48, 90: 1.28, 365: 4 },
  featuredPriceSol: 1,
  paymentsEnabled: true, // UI flag; the server flag PAYMENTS_ENABLED is the real switch (both start off)
};
