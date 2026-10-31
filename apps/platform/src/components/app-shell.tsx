"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export function AppShell({ children, userName, organizationName }: {
  children: React.ReactNode;
  userName?: string;
  organizationName?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login" || pathname === "/setup") return children;
  return <div className="shell">
    <header className="topbar">
      <Link href="/" className="logo">Seam<span>·</span></Link>
      <nav className="nav">
        <Link href="/collaborations">协作</Link>
        <Link href="/projects">项目与 Agent</Link>
        <Link href="/organization">组织</Link>
      </nav>
      <div className="topbar-meta">
        <span>{organizationName} · {userName}</span>
        <button className="btn btn-secondary btn-small" onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/login");
          router.refresh();
        }}>退出</button>
      </div>
    </header>
    <main className="container">{children}</main>
  </div>;
}
