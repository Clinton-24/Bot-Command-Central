const http = require('http');
const PORT = process.env.PORT || 10000; 

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HexaCrimson Labs Bot Command Central is fully operational.\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HexaCrimson] Internal health check server listening on port ${PORT}`);
});

const http = require('http');
const PORT = process.env.PORT || 10000; 

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HexaCrimson Labs Bot Command Central is fully operational.\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HexaCrimson] Internal health check server listening on port ${PORT}`);
});

