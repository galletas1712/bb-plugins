import { QueryClient } from "@tanstack/react-query";

/** One cache survives navigation between reviews, files and conversation tabs. */
export const queryClient = new QueryClient({ defaultOptions: { queries: {
  gcTime: 30 * 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} } });

export const reviewKey = (id: string | null, ...parts: unknown[]) => ["review", id, ...parts];
