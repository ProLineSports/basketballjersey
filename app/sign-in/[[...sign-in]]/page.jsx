'use client';

import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1f1c1e',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <SignIn
        routing="hash"
        withSignUp
        transferable
        oauthFlow="popup"
        fallbackRedirectUrl="/helmet"
        signUpFallbackRedirectUrl="/helmet"
      />
    </main>
  );
}
