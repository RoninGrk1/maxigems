import { deps, handleVerifyPayment } from '../_shared/app.ts';

Deno.serve((req) => handleVerifyPayment(req, deps()));
