import { deps, handleFeatured } from '../_shared/app.ts';

Deno.serve((req) => handleFeatured(req, deps()));
