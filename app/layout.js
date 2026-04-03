// app/layout.js
import { ClerkProvider } from '@clerk/nextjs';

export const metadata = {
  title: 'Jersey Builder — ProLine Mockups',
  description: 'Customize your basketball jersey mockup',
};

const clerkAppearance = {
  layout: {
    socialButtonsPlacement: 'top',
  },
  variables: {
    colorPrimary:        '#efff00',
    colorPrimaryText:    '#000000',
    colorBackground:     '#1e1b1e',
    colorInputBackground:'#2a2730',
    colorInputText:      '#e2e8f0',
    colorText:           '#ffffff',
    colorTextSecondary:  '#cbd5e1',
    colorNeutral:        '#94a3b8',
    colorDanger:         '#ef4444',
    borderRadius:        '8px',
    fontFamily:          'Barlow, Arial Narrow, sans-serif',
    fontWeight:          { normal: 500, medium: 600, bold: 700 },
  },
  elements: {
    card:                      'shadow-2xl border border-white/10',
    rootBox:                   'fixed inset-0 flex items-center justify-center z-50',
    modalBackdrop:             'bg-black/60 backdrop-blur-sm fixed inset-0 z-40',
    formButtonPrimary:         'bg-[#efff00] text-black font-bold hover:bg-[#d4e600]',
    footerActionLink:          { color: '#efff00' },
    identityPreviewText:       { color: '#ffffff' },
    headerTitle:               { color: '#ffffff' },
    headerSubtitle:            { color: '#cbd5e1' },
    socialButtonsBlockButton:  { borderColor: 'rgba(255,255,255,0.1)', color: '#ffffff' },
    dividerLine:               { backgroundColor: 'rgba(255,255,255,0.1)' },
    dividerText:               { color: '#6b7280' },
    formFieldLabel:            { color: '#cbd5e1' },
    formFieldInput:            { borderColor: 'rgba(255,255,255,0.1)', color: '#ffffff' },
    // Account management UI
    navbar:                    { backgroundColor: '#161314', borderColor: 'rgba(255,255,255,0.08)' },
    navbarButton:              { color: '#ffffff' },
    navbarButtonIcon:          { color: '#ffffff' },
    pageScrollBox:             { backgroundColor: '#1e1b1e' },
    page:                      { backgroundColor: '#1e1b1e' },
    profileSectionTitle:       { color: '#ffffff' },
    profileSectionTitleText:   { color: '#ffffff' },
    profileSectionContent:     { color: '#ffffff' },
    profileSectionPrimaryButton: { color: '#efff00' },
    formattedPhoneNumber:      { color: '#ffffff' },
    accordionTriggerButton:    { color: '#ffffff' },
    tableHead:                 { color: '#9ca3af' },
    badge:                     { backgroundColor: 'rgba(239,255,0,0.15)', color: '#efff00', borderColor: 'rgba(239,255,0,0.3)' },
    menuItem:                  { color: '#ffffff' },
    menuList:                  { backgroundColor: '#1e1b1e', borderColor: 'rgba(255,255,255,0.1)' },
    actionCard:                { backgroundColor: '#2a2730', borderColor: 'rgba(255,255,255,0.08)' },
    userPreviewMainIdentifier: { color: '#ffffff' },
    userPreviewSecondaryIdentifier: { color: '#9ca3af' },
    footer:                    { display: 'none' },
  },
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html lang="en">
        <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
