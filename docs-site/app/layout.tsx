import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LiveProbe Documentation",
    template: "%s | LiveProbe",
  },
  description:
    "Install LiveProbe runtime agents, connect MCP tools, and operate bounded production probes.",
  metadataBase: new URL("https://docs.liveprobe.tryastrea.tech"),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Loaded as plain <link> rather than next/font: this site is built by
            vinext, not the Next CLI, so the font-self-hosting build step is not
            part of the pipeline that actually produces dist/client. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
