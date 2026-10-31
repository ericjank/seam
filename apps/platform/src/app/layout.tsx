import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Seam · 项目 Agent 协作平台",
  description: "让独立项目的 AI 安全地完成协商、分工与验收",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const current = await getCurrentUser();
  return <html lang="zh-CN"><body>
    <AppShell userName={current?.user.name} organizationName={current?.organization.name}>{children}</AppShell>
  </body></html>;
}
