// app/layout.js
import { ClerkProvider } from '@clerk/nextjs';

export const metadata = {
  title: 'ProLine Online Builder',
  description: 'Customize ProLine sports mockups',
};

const clerkAppearance = {
  options: {
    socialButtonsPlacement: 'top',
    socialButtonsVariant: 'blockButton',
  },
  variables: {
    colorPrimary: '#efff00',
    colorPrimaryForeground: '#000000',
    colorForeground: '#f8fafc',
    colorMutedForeground: '#cbd5e1',
    colorMuted: '#2a2730',
    colorBackground: '#1e1b1e',
    colorInput: '#2a2730',
    colorInputForeground: '#f8fafc',
    colorNeutral: '#94a3b8',
    colorDanger: '#ff4d4f',
    colorBorder: 'rgba(255,255,255,0.14)',
    colorRing: '#efff00',
    colorModalBackdrop: 'rgba(0,0,0,0.72)',
    borderRadius: '8px',
    fontFamily: 'Barlow, Arial Narrow, sans-serif',
    fontFamilyButtons: 'Barlow, Arial Narrow, sans-serif',
    fontWeight: { normal: 500, medium: 600, semibold: 700, bold: 800 },
  },
  elements: {
    card: {
      backgroundColor: '#1e1b1e',
      border: '1px solid rgba(255,255,255,0.10)',
      boxShadow: '0 24px 70px rgba(0,0,0,0.48)',
    },
    modalBackdrop: {
      backgroundColor: 'rgba(0,0,0,0.72)',
      backdropFilter: 'blur(4px)',
    },
    headerTitle: { color: '#ffffff' },
    headerSubtitle: { color: '#cbd5e1' },
    footerActionText: { color: '#cbd5e1' },
    footerActionLink: { color: '#efff00', fontWeight: 800 },
    identityPreviewText: { color: '#ffffff' },
    identityPreviewEditButton: { color: '#efff00' },
    dividerLine: { backgroundColor: 'rgba(255,255,255,0.12)' },
    dividerText: { color: '#9ca3af' },
    formFieldLabel: { color: '#e5e7eb' },
    formFieldInput: {
      backgroundColor: '#2a2730',
      borderColor: 'rgba(255,255,255,0.14)',
      color: '#f8fafc',
    },
    formFieldInputShowPasswordButton: { color: '#cbd5e1' },
    formFieldErrorText: { color: '#ff6b6b' },
    formFieldSuccessText: { color: '#34d399' },
    alertText: { color: '#ff6b6b' },
    formResendCodeLink: { color: '#efff00' },
    alternativeMethodsBlockButton: { color: '#ffffff' },
    backLink: { color: '#efff00' },
    formButtonPrimary: {
      backgroundColor: '#efff00',
      color: '#000000',
      fontWeight: 900,
      boxShadow: 'none',
    },
    socialButtonsBlockButton: {
      backgroundColor: 'rgba(255,255,255,0.025)',
      borderColor: 'rgba(255,255,255,0.13)',
      color: '#ffffff',
    },
    socialButtonsBlockButtonText: { color: '#ffffff', fontWeight: 700 },
    badge: {
      backgroundColor: '#efff00',
      borderColor: '#efff00',
      color: '#000000',
      fontWeight: 900,
    },
    navbar: { backgroundColor: '#161314', borderColor: 'rgba(255,255,255,0.08)' },
    navbarButton: { color: '#ffffff' },
    navbarButtonIcon: { color: '#ffffff' },
    pageScrollBox: { backgroundColor: '#1e1b1e', color: '#f3f4f6' },
    page: { backgroundColor: '#1e1b1e', color: '#f3f4f6' },
    profileSectionTitle: { color: '#ffffff' },
    profileSectionTitleText: { color: '#ffffff' },
    profileSectionContent: { color: '#f3f4f6' },
    profileSectionPrimaryButton: { color: '#efff00' },
    formattedPhoneNumber: { color: '#ffffff' },
    accordionTriggerButton: { color: '#ffffff' },
    tableHead: { color: '#9ca3af' },
    menuItem: { color: '#ffffff' },
    menuList: { backgroundColor: '#1e1b1e', borderColor: 'rgba(255,255,255,0.1)' },
    actionCard: { backgroundColor: '#2a2730', borderColor: 'rgba(255,255,255,0.08)' },
    userPreviewMainIdentifier: { color: '#ffffff' },
    userPreviewSecondaryIdentifier: { color: '#9ca3af' },
  },
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      signInUrl="/sign-in"
      signInFallbackRedirectUrl="/helmet"
      signUpFallbackRedirectUrl="/helmet"
      supportEmail="support@prolinemockups.com"
    >
      <html lang="en">
        <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
