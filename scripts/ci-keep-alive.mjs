// CI's dev servers only (loaded with NODE_OPTIONS=--import): keep an idle
// keep-alive socket open for 10 minutes instead of Node's 5 s. The specs'
// request contexts reuse sockets, and a read sent on one just as the server
// closed it for idleness failed with ECONNRESET.
import http from "node:http";

const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.keepAliveTimeout = 10 * 60_000;
  return server;
};
