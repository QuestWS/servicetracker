import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Quest Watersports — Service Tracker',
    template: '%s · Quest Service Tracker',
  },
  description:
    'Work order intake, shop-floor logging and live customer status for Quest Watersports service jobs.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Quest Service Tracker',
  appleWebApp: {
    capable: true,
    title: 'Quest Shop',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/quest-mark.png',
    apple: '/icons/apple-touch-icon.png',
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#14293E',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Linked rather than bundled: the shop's two apps share this type
            stack, and a plain <link> keeps the build working offline. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;600&family=Source+Sans+3:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
