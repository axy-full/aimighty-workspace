"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

type SuiteProject = {
  /** The workbench draft captured by this tab, not its production mapping. */
  projectId?: string;
  ready: boolean;
};

const SuiteProjectContext = createContext<SuiteProject | null>(null);

/** Share the shell's account-scoped capture without rereading browser storage. */
export function SuiteProjectProvider({
  projectId,
  ready,
  children,
}: SuiteProject & { children: ReactNode }) {
  const value = useMemo(() => ({ projectId, ready }), [projectId, ready]);
  return (
    <SuiteProjectContext.Provider value={value}>
      {children}
    </SuiteProjectContext.Provider>
  );
}

export function useSuiteProject() {
  const value = useContext(SuiteProjectContext);
  if (!value) throw new Error("useSuiteProject requires SuiteProjectProvider");
  return value;
}
