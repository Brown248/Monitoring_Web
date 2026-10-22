"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/client/fetch";

export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", "POST", {
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
        remember: form.get("remember") === "on",
      });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && (
        <div
          key={error + String(busy)}
          className="animate-pop rounded-lg border border-down/25 bg-down-bg px-3 py-2 text-sm text-down"
        >
          {error}
        </div>
      )}
      <div>
        <label htmlFor="username" className="mb-1.5 block font-medium">
          ชื่อผู้ใช้
        </label>
        <input id="username" name="username" autoComplete="username" required autoFocus />
      </div>
      <div>
        <label htmlFor="password" className="mb-1.5 block font-medium">
          รหัสผ่าน
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="remember" /> จดจำการเข้าสู่ระบบบนเครื่องนี้ 7 วัน
      </label>
      <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
        {busy && (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
            aria-hidden
          />
        )}
        {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}
