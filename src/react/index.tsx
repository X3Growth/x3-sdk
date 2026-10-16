"use client";
/**
 * @x3growth/sdk/react – React adapter (parity TR-08):
 *
 *   <X3Provider options={{ key: "pk_3x_…", host: "/n3" }}>{children}</X3Provider>
 *   const x3 = useX3(); x3.track("signup_started");
 *
 * Initializes the tracker once on mount and stops the pageview on unmount
 * (deferred, so StrictMode's unmount/remount does not split it – TR-06).
 * Route changes are detected by the tracker's History API hook, so no router
 * hooks (usePathname/useSearchParams) are needed.
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { tracker } from "../instance";
import type { X3Api, X3InitOptions } from "../types";

const X3Context = createContext<X3Api>(tracker);

export type X3ProviderProps = { options: X3InitOptions; children?: ReactNode };

export function X3Provider({ options, children }: X3ProviderProps) {
  const key = options.key;
  useEffect(() => {
    tracker.init(options);
    return () => tracker.stop();
    // options are read once per key (re-renders with new object identities must not re-init)
  }, [key]);
  return <X3Context.Provider value={tracker}>{children}</X3Context.Provider>;
}

/** The tracker API (works outside a provider too – it is a singleton) */
export function useX3(): X3Api {
  return useContext(X3Context);
}

/** Tracks one event when the component mounts (e.g. quiz_view on a quiz step) */
export function useTrackOnMount(name: string, props?: Record<string, string | number | boolean>): void {
  const signature = JSON.stringify(props ?? {});
  useEffect(() => {
    tracker.track(name, props);
  }, [name, signature]);
}

export type { X3Api, X3InitOptions };
