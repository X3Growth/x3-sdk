import { X3Analytics } from "@x3growth/sdk/next";

// Root layout of a Next.js App Router project. NEXT_PUBLIC_X3_KEY holds the publishable key (public by design).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* host="/n3" sends through the first-party proxy route below; without it use https://api.x3growth.io */}
        <X3Analytics publishableKey={process.env.NEXT_PUBLIC_X3_KEY!} host="/n3" />
      </body>
    </html>
  );
}
