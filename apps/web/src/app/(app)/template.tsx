import type { ReactNode } from "react";

/** remount ทุกครั้งที่เปลี่ยนหน้า → เล่นอนิเมชั่นเข้าหน้าใหม่ */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-page">{children}</div>;
}
