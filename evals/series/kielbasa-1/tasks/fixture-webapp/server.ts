// Fake webapp for eval task 006-web-wiki: the answer ("nine") is only on a
// page reachable via a link from /. The agent must fetch, read HTML, follow.
// Fixed port: serve tasks assume concurrency 1 (README).

const PORT = 8731;

const home = `<!DOCTYPE html>
<html><head><title>Kielbasa Kitchen</title></head>
<body>
<h1>Kielbasa Kitchen</h1>
<p>Welcome to the kitchen wiki.</p>
<ul>
  <li><a href="/docs/history">History</a></li>
  <li><a href="/docs/menu">Menu</a></li>
</ul>
</body></html>`;

const history = `<!DOCTYPE html>
<html><head><title>History</title></head>
<body>
<h1>History</h1>
<p>The grill was installed in spring. Nothing else to see here.</p>
<p><a href="/docs/recipes">Recipes</a></p>
</body></html>`;

const menu = `<!DOCTYPE html>
<html><head><title>Menu</title></head>
<body>
<h1>Menu</h1>
<p>Today: hot dogs and sparkly water.</p>
</body></html>`;

const recipes = `<!DOCTYPE html>
<html><head><title>Recipes</title></head>
<body>
<h1>Recipes</h1>
<p>The secret bratwurst cure needs exactly nine spices. Do not tell anyone.</p>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const page = { "/": home, "/docs/history": history, "/docs/menu": menu, "/docs/recipes": recipes }[path];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});

console.log(`wiki listening on http://127.0.0.1:${PORT}`);
void server;
