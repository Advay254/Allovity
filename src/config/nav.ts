export interface NavItem {
  label: string;
  href: string;
}

/**
 * Single source for site navigation. Later versions add entries here.
 * Every entry must point to a page or in-page section that exists.
 */
export const primaryNav: readonly NavItem[] = [
  { label: 'Studio', href: '/#studio' },
  { label: 'Capabilities', href: '/#capabilities' },
];

export const headerCta: NavItem = { label: 'Explore products', href: '/#studio' };

export const footerLinks: readonly NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Studio', href: '/#studio' },
  { label: 'Capabilities', href: '/#capabilities' },
];

export const capabilities = [
  { label: 'Communication', icon: 'messages-square' },
  { label: 'Automation', icon: 'workflow' },
  { label: 'Infrastructure', icon: 'server' },
  { label: 'Digital Experiences', icon: 'app-window' },
] as const;
