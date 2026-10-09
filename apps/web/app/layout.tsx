import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Anton, Barlow, Barlow_Condensed, Inter, JetBrains_Mono, Teko } from 'next/font/google';

import { ArenaProvider } from '@/lib/arena-context';
import { ArenaShell } from '@/components/shell';
import './globals.css';
import './stitch-home.css';
import './motion.css';
import './tournament.css';

const barlow = Barlow({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-barlow',
});

const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
  variable: '--font-barlow-condensed',
});

const teko = Teko({
  subsets: ['latin'],
  weight: ['600', '700'],
  display: 'swap',
  variable: '--font-teko',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-jetbrains',
});

const anton = Anton({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-anton',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'PokeArena',
  description: 'Playable Pokémon tournament arena with mocked POKE economics.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable} ${teko.variable} ${jetbrains.variable} ${anton.variable} ${inter.variable}`}>
      <body>
        <div className="site-backdrop" aria-hidden>
          <img src="/brand/night-horizon.png" alt="" />
        </div>
        <ArenaProvider>
          <ArenaShell>{children}</ArenaShell>
        </ArenaProvider>
      </body>
    </html>
  );
}
