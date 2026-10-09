import { prisma } from "../../shared/db.js";

// Default plan catalogue — amounts are RWF and live in the database so they can be
// changed without a deploy. Seeded on startup if the table is empty.
export const DEFAULT_PLANS = [
  { code: "monthly", name: "Monthly", months: 1, priceRwf: 20, sortOrder: 1 },
  { code: "quarterly", name: "3 Months", months: 3, priceRwf: 55, sortOrder: 2 },
  { code: "semiannual", name: "6 Months", months: 6, priceRwf: 100, sortOrder: 3 },
  { code: "yearly", name: "Yearly", months: 12, priceRwf: 180, sortOrder: 4 },
];

export async function ensurePlans() {
  const count = await prisma.plan.count();
  if (count === 0) await prisma.plan.createMany({ data: DEFAULT_PLANS });
}

export const listPlans = () => prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
