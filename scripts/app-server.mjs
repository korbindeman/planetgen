/** Serve the studio and its API on one browser origin, including forwarded ports. */
import page from '../index.html';

const apiPort = Number(process.env.TD_PORT) || 3748;
const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  development: true,
  routes: {
    '/': page,
    '/index.html': page,
    '/api/*': async (req) => {
      const url = new URL(req.url);
      const upstream = new URL(`http://127.0.0.1:${apiPort}`);
      upstream.pathname = url.pathname.slice('/api'.length);
      upstream.search = url.search;
      try {
        return await fetch(new Request(upstream, req), {redirect: 'manual'});
      } catch {
        return Response.json({error: 'The project server is unavailable.'}, {status: 502});
      }
    },
  },
});
console.log(`studio   ${server.url}`);
