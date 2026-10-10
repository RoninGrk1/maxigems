import { deps, handleAuth } from '../_shared/app.ts';

Deno.serve((req) => handleAuth(req, deps()));
