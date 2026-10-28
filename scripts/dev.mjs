const args = process.argv.slice(2);
const value = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

process.env.HOST = value('--host', process.env.HOST || '127.0.0.1');
process.env.PORT = value('--port', process.env.PORT || '12000');
await import('../server/server.mjs');
