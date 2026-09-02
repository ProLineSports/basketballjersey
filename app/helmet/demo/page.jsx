import HelmetBuilder from '../page';

export const metadata = {
  title: 'Interactive Helmet Demo | ProLine',
  robots: {
    index: false,
    follow: false,
  },
};

export default function HelmetDemoPage() {
  return <HelmetBuilder demoMode />;
}
