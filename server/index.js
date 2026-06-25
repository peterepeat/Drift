// =============================================================================
// DRIFT — Worker entry. Static assets (public/) are served by the platform;
// this Worker handles only the dynamic routes, forwarding them to the single
// global WorldRoom Durable Object.
// =============================================================================
export { WorldRoom } from './world-do.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/admin/')) {
      const id = env.WORLD.idFromName('global'); // one world for everyone
      return env.WORLD.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
