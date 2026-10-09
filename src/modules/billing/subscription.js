// Subscription rules (pure functions, no I/O) — easy to unit test.
//
//  * Every business gets a 7-day free trial from activation, whichever plan it picks.
//  * No payment method is needed to start the trial and nothing is charged automatically.
//  * When access is about to end we show the amount and date; the owner chooses to pay.
//  * Paying during the trial keeps every trial day: the paid period starts when access would end.
//  * One trial per phone number / email (enforced at registration via TrialClaim).

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_WINDOW_DAYS = 2;

export function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function accessEndsAt(sub) {
  const t = sub.trialEndsAt?.getTime() ?? 0;
  const p = sub.currentPeriodEnd?.getTime() ?? 0;
  return new Date(Math.max(t, p));
}

export function hasAccess(sub, now = new Date()) {
  return now < accessEndsAt(sub);
}

/** Where a payment made right now would start counting. */
export function nextPeriodStart(sub, now = new Date()) {
  return hasAccess(sub, now) ? accessEndsAt(sub) : now;
}

export function buildSubscriptionView(sub, plans, now = new Date()) {
  const plan = plans.find((p) => p.code === sub.planCode) || plans[0];
  const trialActive = now < sub.trialEndsAt;
  const paidActive = !!sub.currentPeriodEnd && now < sub.currentPeriodEnd;
  const endsAt = accessEndsAt(sub);
  const access = now < endsAt;
  const canceled = !!sub.canceledAt;

  let phase = "EXPIRED";
  if (trialActive) phase = "TRIALING";
  else if (paidActive) phase = "ACTIVE";

  let status = phase;
  if (access && canceled) status = "CANCELED"; // still has access until the end date
  if (!access) status = "EXPIRED";

  const msLeft = Math.max(0, endsAt.getTime() - now.getTime());
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  const trialDaysLeft = trialActive ? Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY_MS) : 0;

  return {
    status,
    phase,
    hasAccess: access,
    trialGranted: sub.trialGranted,
    trialEndsAt: sub.trialEndsAt,
    trialDaysLeft,
    currentPeriodEnd: sub.currentPeriodEnd,
    accessEndsAt: endsAt,
    daysLeft,
    prepaid: !!sub.currentPeriodEnd && sub.currentPeriodEnd > sub.trialEndsAt,
    canceledAt: sub.canceledAt,
    plan: planView(plan),
    // Shown before billing begins so there are no surprise charges.
    nextPayment: canceled ? null : { amountRwf: plan.priceRwf, currency: "RWF", dueDate: endsAt, planCode: plan.code, planName: plan.name, months: plan.months },
    reminder: access && !canceled && msLeft <= REMINDER_WINDOW_DAYS * DAY_MS,
    paymentRequired: !access,
  };
}

export function planView(plan) {
  return { code: plan.code, name: plan.name, months: plan.months, priceRwf: plan.priceRwf, currency: "RWF" };
}

/** Savings vs paying monthly for the same number of months. */
export function withSavings(plans) {
  const monthly = plans.find((p) => p.months === 1);
  return plans.map((p) => {
    const full = monthly ? monthly.priceRwf * p.months : p.priceRwf;
    const saveRwf = Math.max(0, full - p.priceRwf);
    const savePercent = full > 0 ? Math.round((saveRwf / full) * 1000) / 10 : 0;
    return { ...planView(p), saveRwf, savePercent, perMonthRwf: Math.round((p.priceRwf / p.months) * 100) / 100 };
  });
}
