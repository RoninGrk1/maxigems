import { deps } from '../_shared/app.ts';
import { handleFeatured } from '../_shared/featured-http.ts';

Deno.serve((req) => handleFeatured(req, deps()));
