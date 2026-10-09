// Permission catalog (PDF §6): permissions are `resource.action` keys.
// Roles are sets of these keys. Nothing in the code checks role *names*.
// Resources for later phases (orders, kitchen, inventory…) are catalogued now so
// roles built today keep working as those modules ship.

export const PERMISSION_CATALOG = [
  { resource: "orders", label: "Orders", actions: ["view", "create", "update", "cancel", "refund"] },
  { resource: "products", label: "Menu & products", actions: ["view", "create", "update", "delete"] },
  { resource: "tables", label: "Tables & QR codes", actions: ["view", "create", "update", "delete"] },
  { resource: "kitchen", label: "Kitchen display", actions: ["view", "update"] },
  { resource: "payments", label: "Payments & receipts", actions: ["view", "create", "refund"] },
  { resource: "inventory", label: "Inventory", actions: ["view", "create", "update", "delete", "adjust"] },
  { resource: "suppliers", label: "Suppliers & purchases", actions: ["view", "create", "update", "delete"] },
  { resource: "customers", label: "Customers", actions: ["view", "create", "update", "delete"] },
  { resource: "reservations", label: "Reservations", actions: ["view", "create", "update", "cancel"] },
  { resource: "promotions", label: "Promotions & loyalty", actions: ["view", "create", "update", "delete"] },
  { resource: "reports", label: "Reports & analytics", actions: ["view", "export"] },
  { resource: "staff", label: "Staff", actions: ["view", "create", "update", "delete"] },
  { resource: "roles", label: "Roles & permissions", actions: ["view", "create", "update", "delete"] },
  { resource: "settings", label: "Business settings", actions: ["view", "update"] },
  { resource: "billing", label: "Subscription & billing", actions: ["view", "manage"] },
  { resource: "audit", label: "Activity log", actions: ["view"] },
];

export const ALL_PERMISSIONS = PERMISSION_CATALOG.flatMap((g) => g.actions.map((a) => `${g.resource}.${a}`));
const ALL_SET = new Set(ALL_PERMISSIONS);
export const isValidPermission = (p) => ALL_SET.has(p);

const all = (resource) => PERMISSION_CATALOG.find((g) => g.resource === resource).actions.map((a) => `${resource}.${a}`);

// Starter roles seeded for every new business (PDF §3/§6). Owners can edit the
// permissions of all but Owner, and add their own roles.
export const SYSTEM_ROLES = [
  {
    name: "Owner",
    description: "Full access to everything, including billing.",
    isOwner: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: "Manager",
    description: "Runs daily operations. No billing or subscription access.",
    permissions: [
      ...all("orders"), ...all("products"), ...all("tables"), ...all("kitchen"), ...all("inventory"),
      ...all("suppliers"), ...all("customers"), ...all("reservations"), ...all("promotions"),
      ...all("reports"), "staff.view", "staff.create", "staff.update", "settings.view", "payments.view", "payments.create", "payments.refund",
    ],
  },
  {
    name: "Cashier",
    description: "Takes payments and issues receipts.",
    permissions: ["payments.view", "payments.create", "orders.view", "orders.update", "customers.view"],
  },
  {
    name: "Waiter",
    description: "Creates and updates orders, sees tables.",
    permissions: ["orders.view", "orders.create", "orders.update", "tables.view", "products.view", "reservations.view", "reservations.update"],
  },
  {
    name: "Kitchen",
    description: "Sees kitchen orders and updates their status.",
    permissions: ["kitchen.view", "kitchen.update", "orders.view"],
  },
  {
    name: "Barista",
    description: "Prepares coffee orders.",
    permissions: ["orders.view", "orders.update", "products.view", "kitchen.view", "kitchen.update"],
  },
  {
    name: "Inventory Manager",
    description: "Manages stock, suppliers and purchases.",
    permissions: [...all("inventory"), ...all("suppliers"), "products.view"],
  },
];
