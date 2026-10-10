import { deps, handleTelegram } from '../_shared/app.ts';

Deno.serve((req) => handleTelegram(req, deps()));
