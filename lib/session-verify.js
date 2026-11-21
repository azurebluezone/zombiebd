"use strict";

const http = require("http");
const https = require("https");

// <!-- verifySessionWithDomain start -->
function verifySessionWithDomain(sessionId, clientToken, url) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.set("session_id", sessionId);
    const isHttps = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: 10000,
      rejectUnauthorized: true,
      headers: {
        "User-Agent": "MissionBarisal-v3/1.0",
        "X-Session-Id": sessionId,
        "X-Verify-Token": clientToken || "",
      },
    };
    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.verified === true) {
            resolve({
              verified: true,
              session: parsed.session,
              server_time: parsed.server_time,
            });
          } else {
            resolve({
              verified: false,
              error: parsed.error || "verification failed",
            });
          }
        } catch (e) {
          resolve({
            verified: false,
            fallback: true,
            note: "domain response could not be parsed — treat as unverified",
          });
        }
      });
    });
    req.on("error", (err) => {
      resolve({
        verified: false,
        fallback: true,
        note: "domain unreachable — cannot verify token remotely",
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        verified: false,
        fallback: true,
        note: "domain timeout  cannot verify token remotely",
      });
    });
    req.end();
  });
}
// <!-- verifySessionWithDomain end -->

module.exports = { verifySessionWithDomain };
