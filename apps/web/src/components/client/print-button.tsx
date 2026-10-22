"use client";

export function PrintButton() {
  return (
    <button type="button" className="btn-primary" onClick={() => window.print()}>
      พิมพ์ / บันทึกเป็น PDF
    </button>
  );
}
