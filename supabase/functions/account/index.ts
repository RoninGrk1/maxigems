import { deps, handleAccount } from '../_shared/app.ts';

Deno.serve((req) => handleAccount(req, deps()));
