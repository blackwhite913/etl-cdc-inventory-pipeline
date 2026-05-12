"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  label: string;
  href?: string;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const primaryItems: NavItem[] = [
  { label: "Stock On Hand", href: "/extraction" },
  { label: "BOM", href: "/bom" },
  { label: "Shopify", href: "/shopify" },
];

const upcomingItems: NavItem[] = [
  { label: "Sales" },
];

const intelligenceSections: NavSection[] = [
  {
    label: "Intelligence",
    items: [
      { label: "Shop Stock", href: "/intelligence/shop-stock" },
      { label: "Shopify Sales", href: "/intelligence/shopify-sales" },
      { label: "OOS Risk", href: "/intelligence/oos-risk" },
      { label: "Replenishment", href: "/intelligence/replenishment" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r border-white/10 bg-[#0E1624] p-4 text-slate-200 lg:block">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Datasets</h2>
        <p className="mt-1 text-xs text-slate-400">ETL observability</p>
      </div>

      <nav className="space-y-1">
        {primaryItems.map((item) => {
          const active = Boolean(item.href) && (pathname === item.href || pathname?.startsWith(`${item.href}/`));
          if (!item.href) return null;

          return (
            <Link
              key={item.label}
              href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? "bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/30"
                  : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="my-6 border-t border-white/10" />

      <div className="space-y-3">
        {intelligenceSections.map((section) => (
          <div key={section.label} className="space-y-1">
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {section.label}
            </p>
            {section.items.map((item) => {
              const active = Boolean(item.href) && (pathname === item.href || pathname?.startsWith(`${item.href}/`));
              if (!item.href) return null;
              return (
                <Link
                  key={`${section.label}-${item.label}`}
                  href={item.href}
                  className={`block rounded-lg px-3 py-2 text-sm transition ${
                    active
                      ? "bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/30"
                      : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="my-6 border-t border-white/10" />

      <div className="space-y-1">
        {upcomingItems.map((item) => (
          <div key={item.label} className="rounded-lg px-3 py-2 text-sm text-slate-500">
            {item.label}
          </div>
        ))}
      </div>
    </aside>
  );
}
