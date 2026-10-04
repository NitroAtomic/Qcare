// Roles and permissions. Stored in the database at seed time; this file is the source of truth for seeding.
const PERMISSIONS = {
  'dashboard.view': 'See dashboard statistics',
  'patients.view': 'Search and open patient records',
  'patients.register': 'Register and edit patients',
  'visits.view': 'View hospital visits and patient journey',
  'visits.create': 'Create hospital visits',
  'visits.manage': 'Cancel or complete visits',
  'queue.view': 'View all queues (read only)',
  'queue.consultation': 'Manage consultation queues',
  'queue.laboratory': 'Manage laboratory and radiology queues',
  'queue.cashier': 'Manage the cashier queue and record payments',
  'queue.pharmacy': 'Manage the pharmacy queue',
  'route.send': 'Send patients to another department',
  'priority.change': 'Change queue priority',
  'reason.view': 'See reason for visit',
  'search.use': 'Use global search',
  'reports.view': 'View and export reports',
  'audit.view': 'View audit logs',
  'users.manage': 'Manage users',
  'config.manage': 'Manage departments, services, priorities and settings',
  'display.manage': 'Manage the public queue display',
};

const ROLES = {
  super_admin: { name: 'Super Administrator', description: 'Full access to everything', perms: Object.keys(PERMISSIONS) },
  receptionist: { name: 'Receptionist', description: 'Registers patients and creates visits',
    perms: ['dashboard.view', 'patients.view', 'patients.register', 'visits.view', 'visits.create', 'visits.manage', 'queue.view', 'route.send', 'priority.change', 'reason.view', 'search.use'] },
  doctor: { name: 'Doctor', description: 'Manages the consultation queue',
    perms: ['patients.view', 'visits.view', 'queue.consultation', 'route.send', 'priority.change', 'reason.view', 'search.use'] },
  laboratory: { name: 'Laboratory Staff', description: 'Manages laboratory and radiology requests',
    perms: ['visits.view', 'queue.laboratory', 'route.send', 'search.use'] },
  cashier: { name: 'Cashier', description: 'Manages the payment queue',
    perms: ['visits.view', 'queue.cashier', 'route.send', 'search.use'] },
  pharmacist: { name: 'Pharmacist', description: 'Manages the pharmacy queue',
    perms: ['visits.view', 'queue.pharmacy', 'route.send', 'search.use'] },
  display_operator: { name: 'Display Operator', description: 'Manages the public queue display', perms: ['display.manage'] },
};

// Which kind of department each queue permission unlocks
const KIND_PERMISSION = {
  consultation: 'queue.consultation', laboratory: 'queue.laboratory', radiology: 'queue.laboratory',
  cashier: 'queue.cashier', pharmacy: 'queue.pharmacy',
};

// Which department kinds each role may send a patient to
const ROUTE_TARGETS = {
  super_admin: ['consultation', 'laboratory', 'radiology', 'cashier', 'pharmacy', 'registration', 'records', 'billing', 'other'],
  receptionist: ['consultation', 'laboratory', 'radiology', 'cashier', 'pharmacy', 'registration', 'records', 'billing', 'other'],
  doctor: ['consultation', 'laboratory', 'radiology', 'cashier', 'pharmacy'],
  laboratory: ['laboratory', 'radiology', 'cashier'],
  cashier: ['cashier', 'pharmacy'],
  pharmacist: ['cashier'],
};

const PAYMENT_METHODS = ['Cash', 'GCash', 'Maya', 'Card', 'Bank transfer', 'HMO / guarantee letter', 'PhilHealth'];

module.exports = { PERMISSIONS, ROLES, KIND_PERMISSION, ROUTE_TARGETS, PAYMENT_METHODS };
