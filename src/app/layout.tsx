import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cross-Session Memory Agent',
  description: 'An AI chat agent that stores conversation memory on Filecoin for contextual recall across sessions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
