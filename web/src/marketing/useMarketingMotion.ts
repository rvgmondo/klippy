import { useEffect } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * The scripted motion layer: Lenis for the scroll feel, GSAP ScrollTrigger for
 * everything tied to position.
 *
 * Both libraries are imported dynamically inside the effect, so a visitor who
 * asked for reduced motion downloads neither. That is the honest reading of the
 * rule: not "load it and skip the animations" but "do not load it at all".
 *
 * The sync is the one pattern that actually works: Lenis publishes its scroll to
 * ScrollTrigger, and GSAP's ticker drives Lenis, so there is exactly ONE loop
 * driving the page. A second requestAnimationFrame alongside it is the usual
 * cause of jitter. GSAP's ticker reports seconds and Lenis wants milliseconds,
 * hence the multiply, and lag smoothing goes off so a stalled tab does not
 * teleport the page on its way back.
 */
/**
 * The cheap path: reveal on scroll with an IntersectionObserver and a CSS
 * transition, about a kilobyte all in.
 *
 * This is what phones get. Loading GSAP, ScrollTrigger and Lenis costs 132kB of
 * parse, which on a throttled phone CPU measured as 380ms of blocked main thread
 * and held mobile Lighthouse at 79. The smoothing was buying nothing there
 * either: Lenis exists to improve wheel input, and a touch screen already has
 * momentum scrolling that is better than anything JavaScript can impose on it.
 * So the desktop gets the full stack and the phone gets the same reveals for a
 * rounding error.
 */
function lightReveals(): () => void {
  const els = document.querySelectorAll<HTMLElement>('.mk-reveal, .mk-area');
  if (!els.length) return () => {};
  els.forEach((el, i) => {
    el.style.transition = `opacity .5s ease ${Math.min(i % 6, 5) * 0.05}s, transform .5s ease ${Math.min(i % 6, 5) * 0.05}s`;
    el.style.transform = 'translateY(20px)';
  });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      el.style.opacity = '1';
      el.style.transform = 'none';
      io.unobserve(el);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  els.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

/** The full stack is for pointer-and-wheel screens with room to run it. */
function wantsFullMotion(): boolean {
  return window.matchMedia('(min-width: 1024px)').matches
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function useMarketingMotion(): void {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (!wantsFullMotion()) return lightReveals();

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ default: Lenis }, { gsap }, { ScrollTrigger }] = await Promise.all([
        import('lenis'),
        import('gsap'),
        import('gsap/ScrollTrigger'),
      ]);
      if (cancelled) return;

      gsap.registerPlugin(ScrollTrigger);

      const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
      const onScroll = () => ScrollTrigger.update();
      lenis.on('scroll', onScroll);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);

      // In-page links have to go through Lenis, or the browser's own jump fights
      // the smoothing and the two disagree about where the page ended up.
      const onAnchor = (e: MouseEvent) => {
        const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
        const id = link?.getAttribute('href');
        if (!link || !id || id === '#') return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target as HTMLElement, { offset: -24 });
        // Keep the keyboard with the pointer: scrolling somewhere without moving
        // focus leaves a keyboard user tabbing from wherever they were.
        (target as HTMLElement).setAttribute('tabindex', '-1');
        (target as HTMLElement).focus({ preventScroll: true });
      };
      document.addEventListener('click', onAnchor);

      const ctx = gsap.context(() => {
        // Section reveals: transform and opacity only, both GPU-composited.
        // autoAlpha rather than opacity so a hidden block is also out of the
        // hit-testing and the accessibility tree until it arrives.
        gsap.utils.toArray<HTMLElement>('.mk-reveal').forEach((el) => {
          gsap.fromTo(el,
            { autoAlpha: 0, y: 28 },
            {
              autoAlpha: 1, y: 0, duration: 0.65, ease: 'power2.out',
              scrollTrigger: { trigger: el, start: 'top 85%', once: true },
            });
        });

        // The stagger on the five areas: one timeline, not five triggers.
        const areas = gsap.utils.toArray<HTMLElement>('.mk-area');
        if (areas.length) {
          gsap.fromTo(areas,
            { autoAlpha: 0, y: 22 },
            {
              autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.07,
              scrollTrigger: { trigger: areas[0]!.parentElement, start: 'top 80%', once: true },
            });
        }

        // Six labels fall away and the single answer scales up: the argument of
        // the whole product in one gesture. The stage is held by CSS sticky, so
        // this only scrubs opacity and transform against the track's scroll
        // distance. No pin means no injected spacer, which means no layout shift
        // when this chunk arrives, and nothing to trap the scroll or the back
        // button.
        const track = document.querySelector<HTMLElement>('#mk-collapse-track');
        if (track) {
          const tl = gsap.timeline({
            scrollTrigger: {
              trigger: track,
              start: 'top top',
              end: 'bottom bottom',
              scrub: 0.6,
            },
          });
          // Opacity and translate only on the six labels. Scaling TEXT makes the
          // compositor re-rasterise the glyphs on every frame at a new size,
          // which measured as a fifth of frames blowing past 20ms; translating
          // the same text is a matrix on an existing layer and costs nothing.
          tl.to('.mk-scatter-item', {
            autoAlpha: 0, y: -18, stagger: 0.08, ease: 'power1.in',
          })
            .fromTo('#mk-one', { autoAlpha: 0, scale: 0.85 }, { autoAlpha: 1, scale: 1, ease: 'power2.out' }, '-=0.2');
        }
      });

      // will-change goes on the sticky stage only while this page is mounted and
      // comes off in the teardown: left on permanently it costs a layer for
      // nothing.
      const pinned = document.querySelector<HTMLElement>('#mk-collapse');
      if (pinned) pinned.style.willChange = 'transform';

      cleanup = () => {
        document.removeEventListener('click', onAnchor);
        ctx.revert();
        ScrollTrigger.getAll().forEach((t) => t.kill());
        gsap.ticker.remove(tick);
        lenis.off('scroll', onScroll);
        lenis.destroy();
        if (pinned) pinned.style.willChange = '';
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
}
