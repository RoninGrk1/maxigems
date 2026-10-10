import { deps, handleProData } from '../_shared/app.ts';

Deno.serve((req) => handleProData(req, deps()));
