export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="desk-grid grid min-h-dvh place-items-center bg-desk px-5 py-10">
      {children}
    </div>
  );
}
