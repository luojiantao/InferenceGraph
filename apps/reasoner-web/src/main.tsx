import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The graph is polled on a fixed interval; refetch-on-focus would only
      // duplicate that traffic.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('root container missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
