import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Gallery } from './gallery/Gallery';

/**
 * The dev entry point renders the component gallery, not a dashboard.
 *
 * There are no dashboard screens yet — this task builds the state, the models,
 * the API clients and the shared components those screens will be assembled
 * from. The gallery is how they are looked at in the meantime: `npm run dev:web`
 * and every component is on one page, against the fixtures.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('Expected a #root element to mount into');
}

createRoot(container).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
