/** แสดงทันทีระหว่างรอข้อมูลของหน้าถัดไป */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="กำลังโหลด">
      <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-brand/15">
        <div className="nav-progress h-full w-1/2 bg-brand" />
      </div>
      <div className="mb-6 space-y-2">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-80 max-w-full" />
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card space-y-3 px-4 py-4">
            <div className="skeleton h-4 w-24" />
            <div className="skeleton h-7 w-16" />
            <div className="skeleton h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card">
            <div className="border-b border-line px-4 py-3.5">
              <div className="skeleton h-4 w-36" />
            </div>
            <div className="space-y-3 px-4 py-4">
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="flex items-center gap-3">
                  <div className="skeleton h-3 w-3 rounded-full" />
                  <div className="skeleton h-4 flex-1" />
                  <div className="skeleton h-4 w-16" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
