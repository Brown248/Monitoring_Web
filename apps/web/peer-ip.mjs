// โหลดก่อน server.js ของ Next (node --import ./peer-ip.mjs server.js)
// ต่อ IP จริงของ socket ท้าย X-Forwarded-For ทุก request — ผู้ใช้ปลอม header ได้แค่ส่วนซ้าย
// ส่วนขวาสุด (ที่เราใส่เอง / proxy ที่เชื่อถือใส่) ปลอมไม่ได้ · ใช้คู่กับ TRUST_PROXY_HOPS (apps/web/src/lib/api.ts)
// (Next ใส่ x-forwarded-for จาก socket เฉพาะตอนที่ไม่มี header นี้มา → ถ้าผู้ใช้ส่งมาเองจะไม่มี IP จริงเลย)
import http from "node:http";

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, ...rest) {
  if (event === "request" && req?.socket && req.headers) {
    const peer = req.socket.remoteAddress ?? "";
    const prev = req.headers["x-forwarded-for"];
    const chain = Array.isArray(prev) ? prev.join(", ") : prev;
    req.headers["x-forwarded-for"] = chain ? `${chain}, ${peer}` : peer;
  }
  return emit.call(this, event, req, ...rest);
};
process.env.WEB_PEER_IN_XFF = "1";
