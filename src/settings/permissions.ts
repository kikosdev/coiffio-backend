/** Catalogue complet des permissions granulaires (Sprint 10 — Decision #7 amended). */
export const PERMISSIONS = [
  'overview.view',
  'schedule.view', 'schedule.manage',
  'clients.view', 'clients.manage',
  'team.view', 'team.manage',
  'services.view', 'services.manage',
  'finance.view', 'finance.manage', 'finance.refund',
  'stock.view', 'stock.manage',
  'orders.view', 'orders.manage',
  'settings.view', 'settings.manage',
  'reports.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_GROUPS: Record<string, Permission[]> = {
  'Tableau de bord': ['overview.view'],
  'Rendez-vous':     ['schedule.view', 'schedule.manage'],
  'Clients':         ['clients.view', 'clients.manage'],
  'Équipe':          ['team.view', 'team.manage'],
  'Services':        ['services.view', 'services.manage'],
  'Finance':         ['finance.view', 'finance.manage', 'finance.refund'],
  'Stock':           ['stock.view', 'stock.manage'],
  'Commandes':       ['orders.view', 'orders.manage'],
  'Paramètres':      ['settings.view', 'settings.manage'],
  'Rapports':        ['reports.view'],
};

/** Permissions par défaut pour chacun des 4 rôles système. */
export const ROLE_DEFAULT_PERMISSIONS: Record<string, Permission[]> = {
  owner: [...PERMISSIONS],
  manager: [
    'overview.view',
    'schedule.view', 'schedule.manage',
    'clients.view', 'clients.manage',
    'team.view',
    'services.view', 'services.manage',
    'finance.view', 'finance.manage',
    'stock.view', 'stock.manage',
    'orders.view', 'orders.manage',
    'settings.view',
    'reports.view',
  ],
  stylist: [
    'overview.view',
    'schedule.view',
    'clients.view', 'clients.manage',
    'finance.view',
  ],
  colorist: [
    'overview.view',
    'schedule.view',
    'clients.view', 'clients.manage',
    'services.view',
    'stock.view',
    'finance.view',
  ],
  client: [],
};
