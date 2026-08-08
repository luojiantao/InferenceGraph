import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GetReasoningContextOutput, SessionId } from '@reasoner/schema';
import { reasonerApi } from '../api/client.js';
import { useGraphStore } from './graph-store.js';

/** Poll interval for the graph view. Local server, so a short interval is cheap. */
const POLL_MS = 1500;

/**
 * Polls `get_reasoning_context` and funnels every response through the store so
 * out-of-order protection applies in one place. Reconnection is implicit: a
 * failed poll flags the banner, the next success clears it.
 *
 * The event cursor is read from the store inside `queryFn` rather than placed in
 * the query key, so advancing the cursor does not churn a new cache entry per
 * event batch.
 */
export const useReasoningContext = (sessionId: SessionId | null) => {
  const applyView = useGraphStore((state) => state.applyView);
  const reportPollFailure = useGraphStore((state) => state.reportPollFailure);

  const query = useQuery<GetReasoningContextOutput>({
    queryKey: ['reasoning-context', sessionId],
    enabled: sessionId !== null,
    refetchInterval: POLL_MS,
    // Keep the last good graph on screen while a refetch is in flight.
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => {
      if (sessionId === null) return Promise.reject(new Error('no session selected'));
      return reasonerApi.getReasoningContext(sessionId, useGraphStore.getState().cursor, signal);
    },
  });

  useEffect(() => {
    if (query.data !== undefined) applyView(query.data);
  }, [query.data, applyView]);

  useEffect(() => {
    if (query.isError) reportPollFailure();
  }, [query.isError, query.errorUpdatedAt, reportPollFailure]);

  return query;
};

export const useSessions = () =>
  useQuery({
    queryKey: ['sessions'],
    refetchInterval: 5000,
    queryFn: ({ signal }) => reasonerApi.listSessions(signal),
  });
