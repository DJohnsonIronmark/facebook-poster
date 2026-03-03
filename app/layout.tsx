import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import UserMenu from "@/components/UserMenu";

export const metadata: Metadata = {
  title: "Facebook Poster",
  description: "Schedule and publish Facebook posts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-100 min-h-screen">
        <AuthProvider>
          <div className="fixed top-2 right-2 z-50">
            <UserMenu />
          </div>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
