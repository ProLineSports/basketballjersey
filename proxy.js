// proxy.js (place in project root — replaces middleware.js in Next.js 16+)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Only API routes (except webhooks) require auth
// The main page is public — sign-in modal shows as overlay
const isProtectedRoute = createRouteMatcher([
  '/api/user/(.*)',
  '/api/stripe/(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
