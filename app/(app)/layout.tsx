import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  ["Dashboard", "/dashboard"], ["Compose", "/compose"], ["Content Studio", "/content-studio"],
  ["Calendar", "/calendar"], ["Analytics", "/analytics"], ["Connections", "/settings/connections"],
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-neutral-200 bg-white p-4">
        <div className="mb-6 text-lg font-bold">LaunchOS</div>
        <nav className="flex flex-col gap-1">
          {NAV.map(([label, href]) => (
            <Link key={href} href={href} className="rounded px-3 py-2 text-sm hover:bg-neutral-100">{label}</Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
