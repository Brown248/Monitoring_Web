import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS, safeNextPath, type UserRole } from "@app/core";
import { and, eq, getState, gt, lt, sessions, setState, sql, users } from "@app/db";
import argon2 from "argon2";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "./db";
import { cookieSecure, getEnv } from "./env";

export const SESSION_COOKIE = "wm_session";
const REMEMBER_DAYS = 7;

export interface CurrentUser {
  id: number;
  username: string;
  role: UserRole;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// hash จำลองสำหรับ username ที่ไม่มีอยู่ — ใช้เวลาเท่ากันเพื่อไม่ให้เดาชื่อผู้ใช้จากเวลาตอบ
let dummyHash: Promise<string> | null = null;
function getDummyHash() {
  dummyHash ??= argon2.hash(randomBytes(16).toString("hex"), { type: argon2.argon2id });
  return dummyHash;
}

export type LoginResult =
  | { ok: true; user: CurrentUser; token: string; expiresAt: Date; remember: boolean }
  | { ok: false; error: string; status: number };

/** ผิดเกินนี้จากหลาย IP รวมกัน → ล็อกทั้งบัญชี (กันเดารหัสแบบกระจาย) */
const ACCOUNT_MAX_FAILED = 20;
const GENERIC_ERROR = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง";
const lockedError = (mins: number) => `ลองผิดหลายครั้งเกินไป กรุณารออีก ${mins} นาทีแล้วลองใหม่`;

/**
 * ผิดติดกันต่อคู่ "ชื่อผู้ใช้ + IP" (ในหน่วยความจำ) — คนที่ยิงรหัสผิดล็อกได้แค่ตัวเอง
 * ไม่ทำให้เจ้าของบัญชีตัวจริงที่อยู่คนละเครื่องเข้าไม่ได้ · นับชื่อที่ไม่มีอยู่จริงด้วย (เดาชื่อผู้ใช้ไม่ได้)
 */
const pairFails = new Map<string, { count: number; until: number }>();

function pairLockedMins(key: string): number {
  const p = pairFails.get(key);
  if (!p || p.count < MAX_FAILED_LOGINS) return 0;
  if (p.until <= Date.now()) {
    pairFails.delete(key);
    return 0;
  }
  return Math.ceil((p.until - Date.now()) / 60_000);
}

function registerPairFail(key: string): number {
  const now = Date.now();
  const p = pairFails.get(key);
  const next =
    !p || p.until <= now ? { count: 1, until: now + LOCKOUT_MINUTES * 60_000 } : { ...p, count: p.count + 1 };
  if (next.count >= MAX_FAILED_LOGINS) next.until = now + LOCKOUT_MINUTES * 60_000;
  pairFails.set(key, next);
  // ไม่ให้ Map โตไม่จำกัด (เช่น สแกนชื่อผู้ใช้จำนวนมาก)
  if (pairFails.size > 10_000) for (const [k, v] of pairFails) if (v.until <= now) pairFails.delete(k);
  return next.count >= MAX_FAILED_LOGINS ? LOCKOUT_MINUTES : 0;
}

/**
 * IP ที่เคย login สำเร็จของผู้ใช้แต่ละคน (เก็บ 10 IP ล่าสุด 90 วัน) — การล็อกทั้งบัญชี (กันเดารหัสจากหลาย IP)
 * ไม่ใช้กับ IP เหล่านี้: คนร้ายยิงรหัสผิดจากที่อื่นจนบัญชีล็อก เจ้าของตัวจริงยังเข้าจากเครื่องประจำได้
 * (IP เหล่านี้ยังโดนจำกัดรายคู่ "ชื่อผู้ใช้ + IP" ตามปกติ)
 */
const KNOWN_IPS = 10;
const KNOWN_IP_DAYS = 90;
type KnownIps = Array<{ ip: string; at: string }>;

async function isKnownIp(userId: number, ip: string): Promise<boolean> {
  if (ip === "direct" || ip === "unknown") return false;
  const list = (await getState<KnownIps>(getDb(), `login-ips:${userId}`)) ?? [];
  const since = Date.now() - KNOWN_IP_DAYS * 86_400_000;
  return list.some((k) => k.ip === ip && Date.parse(k.at) > since);
}

async function rememberIp(userId: number, ip: string): Promise<void> {
  if (ip === "direct" || ip === "unknown") return;
  const key = `login-ips:${userId}`;
  const list = ((await getState<KnownIps>(getDb(), key)) ?? []).filter((k) => k.ip !== ip);
  await setState(getDb(), key, [{ ip, at: new Date().toISOString() }, ...list].slice(0, KNOWN_IPS));
}

export async function login(
  username: string,
  password: string,
  remember: boolean,
  clientIp = "unknown",
): Promise<LoginResult> {
  const db = getDb();
  const pairKey = `${username}\n${clientIp}`;
  const pairMins = pairLockedMins(pairKey);
  if (pairMins > 0) return { ok: false, status: 429, error: lockedError(pairMins) };

  const [user] = await db.select().from(users).where(eq(users.username, username));
  // ชื่อที่ไม่มีอยู่ก็ verify กับ hash จำลอง — เวลาตอบเท่ากัน เดาชื่อผู้ใช้จากเวลาไม่ได้
  let valid = false;
  if (user) valid = await argon2.verify(user.passwordHash, password).catch(() => false);
  else await argon2.verify(await getDummyHash(), password).catch(() => false);

  const known = user ? await isKnownIp(user.id, clientIp) : false;
  // บัญชีถูกล็อก (ผิดเกินจากหลาย IP) — ตอบเหมือนกรณีล็อกปกติ ไม่บอกว่าบัญชีมีอยู่จริง
  // ยกเว้น IP ที่เจ้าของเคย login สำเร็จ (ไม่ให้คนร้ายล็อกเจ้าของบัญชีออกจากระบบได้)
  if (user?.lockedUntil && user.lockedUntil > new Date() && !known)
    return {
      ok: false,
      status: 429,
      error: lockedError(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000)),
    };

  if (!user || !user.isActive || !valid) {
    if (user && user.isActive && !known) {
      // เพิ่มแบบ atomic ใน SQL — ยิงพร้อมกันหลายร้อยครั้งก็นับครบทุกครั้ง
      await db.execute(sql`
        UPDATE users SET
          locked_until = CASE WHEN failed_login_count + 1 >= ${ACCOUNT_MAX_FAILED}
                              THEN now() + make_interval(mins => ${LOCKOUT_MINUTES}) ELSE locked_until END,
          failed_login_count = CASE WHEN failed_login_count + 1 >= ${ACCOUNT_MAX_FAILED} THEN 0 ELSE failed_login_count + 1 END
        WHERE id = ${user.id}
      `);
    }
    const mins = registerPairFail(pairKey);
    return mins > 0
      ? { ok: false, status: 429, error: lockedError(mins) }
      : { ok: false, status: 401, error: GENERIC_ERROR };
  }
  pairFails.delete(pairKey);

  const token = randomBytes(32).toString("base64url");
  const ttlMs = remember ? REMEMBER_DAYS * 86_400_000 : getEnv().SESSION_TTL_HOURS * 3_600_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt });
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await rememberIp(user.id, clientIp);
  // ล้าง session หมดอายุของผู้ใช้คนนี้ไปด้วย
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, new Date())));
  return {
    ok: true,
    user: { id: user.id, username: user.username, role: user.role },
    token,
    expiresAt,
    remember,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date, remember: boolean): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    // ไม่ติ๊ก "จดจำ" = session cookie (หายเมื่อปิดเบราว์เซอร์) แต่ฝั่ง server ยังหมดอายุตาม SESSION_TTL_HOURS
    ...(remember ? { expires: expiresAt } : {}),
  });
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token)
    await getDb()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
  store.delete(SESSION_COOKIE);
}

export async function revokeUserSessions(userId: number, exceptToken?: string): Promise<void> {
  const db = getDb();
  if (exceptToken) {
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), sql`${sessions.tokenHash} <> ${hashToken(exceptToken)}`));
  } else {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }
}

export async function currentToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** ผู้ใช้ของ request นี้ (cache ต่อ request) */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = await currentToken();
  if (!token) return null;
  const [row] = await getDb()
    .select({ id: users.id, username: users.username, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    );
  return row ?? null;
});

/** ใช้ในหน้า (server component) — ไม่มี session → ไปหน้า login */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const here = safeNext((await headers()).get("x-wm-path"));
    redirect(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
  }
  return user;
}

/** ปลายทางหลัง login — รับเฉพาะ path ภายในเว็บนี้ (ดู safeNextPath ใน @app/core) */
export const safeNext = safeNextPath;
