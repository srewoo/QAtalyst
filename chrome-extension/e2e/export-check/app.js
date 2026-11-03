const http = require('http');
const page = `<!doctype html><title>Sign in</title>
<form id="login"><label for="e">Email</label><input id="e" name="email" type="email">
<label for="p">Password</label><input id="p" name="password" type="password">
<button id="signin" type="submit">Sign In</button></form><p id="msg" role="alert"></p>
<script>document.getElementById('login').onsubmit = async (ev) => { ev.preventDefault();
  const r = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ e: e.value, p: p.value }) });
  if (r.ok) location.href = '/dashboard'; else document.getElementById('msg').textContent = 'Invalid password'; };</script>`;
module.exports = () => http.createServer((req, res) => {
  if (req.url === '/api/auth/login') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const ok = JSON.parse(b).p === 'right'; res.writeHead(ok ? 200 : 401); res.end(); });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/dashboard' ? '<h1>Dashboard</h1>' : page);
});
