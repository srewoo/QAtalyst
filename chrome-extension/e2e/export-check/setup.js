// Local stand-ins: the login app (4977) the exported tests run against, and a fake
// Ollama (4978) the panel test uses as its model.
module.exports = async () => {
  const servers = [require('./app.js')(), require('./fake-ollama.js')()];
  await Promise.all(servers.map((s, i) => new Promise(r => s.listen(4977 + i, r))));
  return () => servers.forEach(s => s.close());
};
