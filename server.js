const http = require('http');
const handler = require('./lurl');

const PORT = process.env.PORT || 4017;

const server = http.createServer((req, res) => {
  handler.handle(req, res);
});

server.listen(PORT, () => {
  console.log(`[LurlHub] Running on port ${PORT}`);
});
