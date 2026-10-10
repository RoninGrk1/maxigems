import { deps, handleCreateOrder } from '../_shared/app.ts';

Deno.serve((req) => handleCreateOrder(req, deps()));
