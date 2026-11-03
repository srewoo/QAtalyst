// A stand-in for a local Ollama (OpenAI-compatible /v1/chat/completions). For a
// test-generation prompt it writes one grounded test that restates the focused
// acceptance criterion; anything else gets an unparseable reply, which the
// extension must handle (deterministic controller, reported critic/judge gaps).
const http = require('http');

function reply(system) {
  if (!system.includes('generating GROUNDED')) return 'not json';
  const focus = (system.match(/focused on: (.*)\.\n/) || [])[1] || 'the ticket as a whole';
  const cat = (system.match(/exactly \d+ (\w+) test cases/) || [])[1] || 'Positive';
  const criterion = (focus.match(/^Acceptance criterion: (.*)$/) || [])[1] || `Sign in with email and password (${focus})`;
  return JSON.stringify({ tests: [{
    title: criterion.slice(0, 120), category: cat, priority: 'P1',
    preconditions: 'A registered user on http://127.0.0.1:4977/login',
    steps: ['Type "a@b.co" in the "Email" field', 'Type "nope" in the "Password" field', 'Click "Sign In"'],
    expected_result: criterion
  }] });
}

// Every prompt received, so a test can compare what the generator was given.
const prompts = [];
const text = (c) => (Array.isArray(c) ? c.map(p => p.text || '').join('\n') : String(c || ''));

module.exports = () => http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    if (req.url === '/__prompts') { res.end(JSON.stringify(prompts)); return; }
    if (req.url === '/__reset') { prompts.length = 0; res.end('{}'); return; }
    if (req.url.startsWith('/v1/models') || req.url.startsWith('/api/tags')) {
      res.end(JSON.stringify({ data: [{ id: 'fake' }], models: [{ name: 'fake' }] }));
      return;
    }
    let system = '';
    let user = '';
    try {
      const msgs = JSON.parse(body || '{}').messages || [];
      system = msgs.filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
      user = msgs.filter(m => m.role === 'user').map(m => text(m.content)).join('\n');
    } catch (_) { /* empty */ }
    prompts.push({ system, user });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply(system) } }] }));
  });
});
