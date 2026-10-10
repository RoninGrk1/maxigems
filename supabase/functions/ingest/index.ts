import { deps, handleIngest } from '../_shared/app.ts';

Deno.serve((req) => handleIngest(req, deps()));
