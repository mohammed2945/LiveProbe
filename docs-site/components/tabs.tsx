"use client";

import { useId, useState, type ReactNode } from "react";

export type Tab = {
  id: string;
  label: string;
  content: ReactNode;
};

export function Tabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const groupId = useId();

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${groupId}-${tab.id}-tab`}
              aria-selected={selected}
              aria-controls={`${groupId}-${tab.id}-panel`}
              className={selected ? "tab is-active" : "tab"}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        // Every panel stays in the markup and inactive ones are hidden, rather
        // than only rendering the active one. The site search indexes the
        // rendered page, and this is a static export, so a panel that is not
        // in the HTML would be invisible to search engines and to readers who
        // arrive from one.
        <div
          key={tab.id}
          role="tabpanel"
          id={`${groupId}-${tab.id}-panel`}
          aria-labelledby={`${groupId}-${tab.id}-tab`}
          hidden={tab.id !== active}
          className="tab-panel"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
