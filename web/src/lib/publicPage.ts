import { useEffect } from 'react';

/**
 * The two things every page a non-user sees has to fix about the shared index.html.
 *
 * Klippy is one deploy serving three applications off one HTML file, and that file is
 * written for the marketing page: it carries the Klippy headline and no robots
 * directive, both of which are right for the landing page and wrong for anything a
 * client opens.
 *
 * These live in one place because there will be more such pages, and the failure mode
 * is silent. Nothing breaks when a portal tab says "Klippy: run the work, the time and
 * the invoice in one place"; a client just quietly learns the name of the tool their
 * supplier uses, on a screen designed to show them no trace of it.
 */

/** Name the tab after whoever the reader thinks they are dealing with. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

/**
 * Keep this page out of search results.
 *
 * Set from script rather than in index.html because that file is shared with the
 * public marketing page, which must stay indexable. A crawler that runs JavaScript
 * mounts the app first and reads the tag this adds; one that does not never sees the
 * client's page at all, since there is nothing linking to it.
 *
 * Worth doing even where nothing links in: portal sign-in links carry a token in the
 * query string, and a tokenised URL in a search index is a door left open.
 */
export function useNoIndex(): void {
  useEffect(() => {
    let tag = document.querySelector('meta[name="robots"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'robots');
      document.head.appendChild(tag);
    }
    tag.setAttribute('content', 'noindex, nofollow');
  }, []);
}
