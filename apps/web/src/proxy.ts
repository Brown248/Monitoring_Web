import { NextResponse, type NextRequest } from "next/server";

/**
 * ตรวจแบบ optimistic: ไม่มี session cookie → ไปหน้า login
 * การตรวจจริง (session ใน DB, สิทธิ์) ทำใน layout/route handler ทุกครั้ง
 */
export function proxy(request: NextRequest) {
  const here = request.nextUrl.pathname + request.nextUrl.search;
  if (!request.cookies.has("wm_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = here === "/" ? "" : `?next=${encodeURIComponent(here)}`;
    return NextResponse.redirect(url);
  }
  // ให้ requireUser รู้หน้าปัจจุบัน — session หมดอายุแล้ว login เสร็จจะได้กลับมาหน้าเดิม
  const headers = new Headers(request.headers);
  headers.set("x-wm-path", here);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // ยกเว้น login, API (ตอบ 401 เอง), health และไฟล์ static
  matcher: ["/((?!login|api/|_next/|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js|woff2?)$).*)"],
};
