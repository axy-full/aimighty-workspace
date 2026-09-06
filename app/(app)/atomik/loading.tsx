import { AtomikSpinner } from "@/components/AtomikMark";

/** What an atomik screen shows while its bundle is on the way. */
export default function AtomikLoading() {
  return (
    <div className="screen grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-dim">
        <AtomikSpinner size={26} />
        <p className="text-[14px]">Opening</p>
      </div>
    </div>
  );
}
