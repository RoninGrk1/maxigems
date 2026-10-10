import { deps, handlePay } from '../_shared/app.ts';

Deno.serve((req) => handlePay(req, deps()));
