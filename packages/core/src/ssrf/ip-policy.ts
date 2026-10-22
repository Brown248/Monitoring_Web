import { BlockList, isIP } from "node:net";

/**
 * ช่วง IP ที่ห้ามเชื่อมต่อ (private / loopback / link-local / reserved / multicast)
 * BlockList ตรวจ IPv4-mapped IPv6 (::ffff:10.0.0.1) ให้อัตโนมัติ
 */
const blocked = new BlockList();
const V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

export type IpCategory = "public" | "private" | "invalid";

export function classifyIp(ip: string): IpCategory {
  const family = isIP(ip);
  if (family === 0) return "invalid";
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6") ? "private" : "public";
}

export function isBlockedIp(ip: string): boolean {
  return classifyIp(ip) !== "public";
}
