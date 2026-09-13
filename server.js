import http from "node:http";

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "referral-market-agent"
  }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Agent running on port ${port}`);
});
