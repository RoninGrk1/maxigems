import { deps, handleSweep } from '../_shared/app.ts';

Deno.serve((req) => handleSweep(req, deps()));
