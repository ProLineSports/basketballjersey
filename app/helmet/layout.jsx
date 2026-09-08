'use client';

import { usePathname } from 'next/navigation';
import BuilderProtectionLayout from '@/components/BuilderProtectionLayout';

export default function Layout({ children }) {
  const pathname = usePathname();

  // The public landing-page demo must use the real renderer without the normal
  // desktop gate, account watermark, or other protected-builder chrome.
  if (pathname === '/helmet/demo') {
    return children;
  }

  return <BuilderProtectionLayout>{children}</BuilderProtectionLayout>;
}
