import { useEffect, useRef } from 'react';
import {
  BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments,
  PerspectiveCamera, Points, PointsMaterial, Scene, WebGLRenderer,
} from 'three';

/**
 * The hero's signal field: scattered points drifting toward one centre.
 *
 * The whole pitch is "six tools, one place", so the one piece of 3D on the page
 * argues that and nothing else: points wander, and the ones that come near each
 * other are joined by a line, so order appears out of scatter as you watch. No
 * models, no textures, no lights. Just a point cloud and the lines between
 * neighbours, which keeps the payload to geometry the GPU can chew on and means
 * there is nothing to load over the network once the module lands.
 *
 * Everything expensive is conditional. This module is imported lazily and only
 * when the caller has already checked that WebGL exists and that the visitor has
 * not asked for reduced motion, so a phone with no WebGL, or someone with
 * vestibular sensitivity, never pays for a line of it. On unmount every buffer,
 * material and the renderer's own context are released by hand: a canvas that
 * quietly holds a GPU context after its React tree is gone is how a single-page
 * app runs a laptop's fan for the rest of the session.
 */
const COUNT = 90;
const LINK_DISTANCE = 2.1;
/** Two points can be joined at most once, so the line buffer has a hard ceiling. */
const MAX_LINKS = 420;

export default function SignalField({ accent }: { accent: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch {
      return; // Context creation can still fail on a driver the probe passed.
    }

    // Cap DPR at 2, and let three set the element's CSS size as well as its
    // backing store: with updateStyle off the canvas keeps no CSS size and lays
    // out at its DPR-scaled pixel width, which on a 2x screen is twice the box
    // it was meant to fill.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.z = 9;

    // Positions and a per-point drift, in one flat pair of arrays so the frame
    // loop never allocates.
    const positions = new Float32Array(COUNT * 3);
    const drift = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 9;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6;
      drift[i * 3] = (Math.random() - 0.5) * 0.0055;
      drift[i * 3 + 1] = (Math.random() - 0.5) * 0.0055;
      drift[i * 3 + 2] = (Math.random() - 0.5) * 0.0035;
    }

    const pointGeo = new BufferGeometry();
    pointGeo.setAttribute('position', new BufferAttribute(positions, 3));
    const pointMat = new PointsMaterial({
      color: new Color(accent), size: 0.075, transparent: true, opacity: 0.85, depthWrite: false,
    });
    const points = new Points(pointGeo, pointMat);
    scene.add(points);

    const linkPositions = new Float32Array(MAX_LINKS * 6);
    const linkGeo = new BufferGeometry();
    const linkAttr = new BufferAttribute(linkPositions, 3);
    linkAttr.setUsage(35048 /* DynamicDrawUsage */);
    linkGeo.setAttribute('position', linkAttr);
    const linkMat = new LineBasicMaterial({
      color: new Color(accent), transparent: true, opacity: 0.16, depthWrite: false,
    });
    const links = new LineSegments(linkGeo, linkMat);
    scene.add(links);

    // The pointer nudges the field instead of moving the camera, so nothing
    // scrolls or reflows: a lerped rotation on two axes and nothing more.
    let targetX = 0;
    let targetY = 0;
    const onPointer = (e: PointerEvent) => {
      targetX = (e.clientX / window.innerWidth - 0.5) * 0.35;
      targetY = (e.clientY / window.innerHeight - 0.5) * 0.25;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const onResize = () => {
      if (!mount.clientWidth) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // A hidden tab should not be rendering. Without this the loop keeps the GPU
    // awake behind whatever the visitor switched to.
    let visible = document.visibilityState === 'visible';
    const onVisibility = () => { visible = document.visibilityState === 'visible'; };
    document.addEventListener('visibilitychange', onVisibility);

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!visible) return;

      const pos = pointGeo.getAttribute('position') as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < COUNT; i++) {
        const ix = i * 3;
        arr[ix] += drift[ix]!;
        arr[ix + 1] += drift[ix + 1]!;
        arr[ix + 2] += drift[ix + 2]!;
        // Turn back at the edges rather than wrapping, so nothing ever pops.
        if (Math.abs(arr[ix]!) > 7) drift[ix] = -drift[ix]!;
        if (Math.abs(arr[ix + 1]!) > 4.5) drift[ix + 1] = -drift[ix + 1]!;
        if (Math.abs(arr[ix + 2]!) > 3) drift[ix + 2] = -drift[ix + 2]!;
      }
      pos.needsUpdate = true;

      // Join near neighbours. O(n^2) over 90 points is ~4k comparisons a frame,
      // which is nothing; the ceiling on links is what keeps the draw honest.
      let n = 0;
      for (let i = 0; i < COUNT && n < MAX_LINKS; i++) {
        for (let j = i + 1; j < COUNT && n < MAX_LINKS; j++) {
          const dx = arr[i * 3]! - arr[j * 3]!;
          const dy = arr[i * 3 + 1]! - arr[j * 3 + 1]!;
          const dz = arr[i * 3 + 2]! - arr[j * 3 + 2]!;
          if (dx * dx + dy * dy + dz * dz > LINK_DISTANCE * LINK_DISTANCE) continue;
          linkPositions[n * 6] = arr[i * 3]!;
          linkPositions[n * 6 + 1] = arr[i * 3 + 1]!;
          linkPositions[n * 6 + 2] = arr[i * 3 + 2]!;
          linkPositions[n * 6 + 3] = arr[j * 3]!;
          linkPositions[n * 6 + 4] = arr[j * 3 + 1]!;
          linkPositions[n * 6 + 5] = arr[j * 3 + 2]!;
          n++;
        }
      }
      linkGeo.setDrawRange(0, n * 2);
      linkAttr.needsUpdate = true;

      points.rotation.y += (targetX - points.rotation.y) * 0.03;
      points.rotation.x += (targetY - points.rotation.x) * 0.03;
      links.rotation.copy(points.rotation);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.remove(points, links);
      pointGeo.dispose();
      linkGeo.dispose();
      pointMat.dispose();
      linkMat.dispose();
      // forceContextLoss releases the GPU context itself; dispose alone leaves it
      // held until the browser decides otherwise.
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [accent]);

  return <div ref={host} className="absolute inset-0" aria-hidden="true" />;
}
