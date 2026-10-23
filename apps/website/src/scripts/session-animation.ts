import { gsap } from "gsap";

const DURATION = 21;

interface PlaybackLine {
  element: HTMLElement;
  paragraph: HTMLElement;
  at: number;
  text: string;
}

/** One owned timeline keeps the console and the physical scene seekable together. */
export function mountSessionAnimation(demo: HTMLElement): void {
  const toggle = demo.querySelector<HTMLButtonElement>("[data-toggle]");
  const scrub = demo.querySelector<HTMLInputElement>("[data-scrub]");
  const transcript = demo.querySelector<HTMLElement>("[data-transcript]");
  const caption = demo.querySelector<HTMLElement>("[data-caption]");
  const clockLabel = demo.querySelector<HTMLElement>("[data-clock]");
  const controls = demo.querySelector<HTMLElement>("[data-controls]");
  if (!toggle || !scrub || !transcript || !caption || !clockLabel || !controls) return;

  const parsed: unknown = JSON.parse(demo.dataset.beats ?? "[]");
  const beats: string[] =
    Array.isArray(parsed) && parsed.every((value: unknown): boolean => typeof value === "string")
      ? parsed
      : [];
  const lines = Array.from(demo.querySelectorAll<HTMLElement>("[data-message]"))
    .map((element: HTMLElement): PlaybackLine | null => {
      const paragraph = element.querySelector<HTMLElement>("[data-message-text]");
      return paragraph
        ? {
            element,
            paragraph,
            at: Number(element.dataset.at) / 1000,
            text: element.dataset.text ?? "",
          }
        : null;
    })
    .filter((line: PlaybackLine | null): line is PlaybackLine => line !== null);

  const media = gsap.matchMedia();
  media.add(
    {
      motion: "(prefers-reduced-motion: no-preference)",
      reduce: "(prefers-reduced-motion: reduce)",
    },
    (context: gsap.Context): (() => void) => {
      const reduced = context.conditions?.reduce ?? false;
      const abort = new AbortController();
      const options = { signal: abort.signal };
      const clock = { elapsed: 0 };
      let started: boolean = false;
      let visible: boolean = false;
      const timeline = gsap.timeline({
        paused: true,
        defaults: { duration: 0.5, ease: "power2.inOut" },
      });

      function render(): void {
        const elapsed = clock.elapsed;
        let current: number = 0;
        let changed: boolean = false;
        lines.forEach((line: PlaybackLine, index: number): void => {
          const shown = elapsed >= line.at;
          if (shown) current = index;
          if (line.element.hidden !== !shown) {
            line.element.hidden = !shown;
            changed = true;
          }
          const count = reduced
            ? line.text.length
            : Math.max(0, Math.floor((elapsed - line.at) * 40));
          const text = line.text.slice(0, count);
          if (line.paragraph.textContent !== text) {
            line.paragraph.textContent = text;
            changed = true;
          }
        });
        if (changed && transcript) transcript.scrollTop = transcript.scrollHeight;
        demo.dataset.beat = String(current);
        const playing = !timeline.paused() && elapsed < DURATION - 0.01;
        demo.dataset.playing = String(playing);
        if (caption) caption.textContent = beats[current] ?? "";
        if (scrub) {
          scrub.value = String(Math.round(elapsed * 1000));
          scrub.setAttribute("aria-valuetext", beats[current] ?? "");
        }
        if (clockLabel)
          clockLabel.textContent = `0:${String(Math.floor(elapsed)).padStart(2, "0")}`;
        if (toggle)
          toggle.textContent = playing
            ? (demo.dataset.pauseLabel ?? "")
            : elapsed >= DURATION - 0.01
              ? (demo.dataset.replayLabel ?? "")
              : (demo.dataset.playLabel ?? "");
      }

      // Labels are narrative beats. All motion, including the console clock, lives here.
      timeline
        .addLabel("prompt", 0)
        .addLabel("popup", 1.6)
        .addLabel("archives", 3.4)
        .addLabel("engram", 4.9)
        .addLabel("codegraph", 8.5)
        .addLabel("chip", 11.6)
        .addLabel("integrate", 13.3)
        .addLabel("fast-search", 14.4)
        .addLabel("ready", 19);
      timeline.to(clock, { elapsed: DURATION, duration: DURATION, ease: "none" }, 0);

      gsap.set("[data-robot-pop]", {
        autoAlpha: 0,
        y: 85,
        scale: 0.15,
        transformOrigin: "50% 100%",
      });
      gsap.set("[data-cabinet]", { autoAlpha: 0, y: 18 });
      gsap.set(
        ".flying-file, [data-chip], [data-bubble], [data-speed-lines], [data-integrated-chip], [data-integration-ring], [data-prompt-packet], [data-portal], [data-ready]",
        { autoAlpha: 0 },
      );
      gsap.set("[data-arm-left]", { transformOrigin: "100% 90%" });
      gsap.set("[data-arm-right]", { transformOrigin: "0% 90%" });
      gsap.set("[data-leg-left]", { transformOrigin: "50% 0%" });
      gsap.set("[data-leg-right]", { transformOrigin: "50% 0%" });
      gsap.set("[data-robot-body]", { transformOrigin: "50% 95%" });
      gsap.set("[data-chip]", { svgOrigin: "0 0" });

      // The prompt crosses into the scene; the robot grows out of its landing ring.
      timeline
        .fromTo(
          "[data-prompt-packet]",
          { x: -40, autoAlpha: 0 },
          { x: 360, y: 45, autoAlpha: 1, duration: 1.25, ease: "power2.in" },
          0.25,
        )
        .to("[data-prompt-packet]", { autoAlpha: 0, scale: 0.35, duration: 0.2 }, 1.5)
        .fromTo(
          "[data-portal]",
          { autoAlpha: 0, scale: 0.25 },
          { autoAlpha: 1, scale: 1, duration: 0.45, transformOrigin: "50% 50%" },
          "popup",
        )
        .to(
          "[data-robot-pop]",
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.75, ease: "back.out(1.5)" },
          "popup+=.2",
        )
        .to("[data-portal]", { autoAlpha: 0, scale: 1.3, duration: 0.5 }, "popup+=1")
        .fromTo(
          "[data-bubble]",
          { autoAlpha: 0, y: 12, scale: 0.8 },
          { autoAlpha: 1, y: 0, scale: 1, transformOrigin: "50% 100%", duration: 0.4 },
          2.5,
        )
        .to("[data-bubble]", { autoAlpha: 0, y: -8, duration: 0.25 }, 4)
        .to(
          "[data-cabinet]",
          { autoAlpha: 1, y: 0, stagger: 0.3, duration: 0.7, ease: "power3.out" },
          "archives",
        );

      // Slow physical search: walk to each archive, pull a drawer, inspect a few files.
      timeline
        .to("[data-robot-move]", { x: -125, duration: 1, ease: "power1.inOut" }, 4)
        .to("[data-drawer-left='0']", { x: 48, y: 10, duration: 0.7 }, "engram")
        .to("[data-drawer-left='0'] .drawer-top", { autoAlpha: 1, duration: 0.3 }, "engram")
        .to("[data-drawer-left='1']", { x: 27, y: 5, duration: 0.65 }, 6.2)
        .to("[data-drawer-left='1'] .drawer-top", { autoAlpha: 1, duration: 0.3 }, 6.2)
        .to("[data-robot-eyes]", { x: -6, duration: 0.2 }, 4.5)
        .to("[data-arm-left]", { rotation: -24, duration: 0.38, yoyo: true, repeat: 5 }, 5)
        .to("[data-robot-body]", { rotation: -4, y: 2, duration: 0.6, yoyo: true, repeat: 3 }, 5)
        .to("[data-drawer-left]", { x: 0, y: 0, stagger: 0.1, duration: 0.45 }, 7.5)
        .to("[data-drawer-left] .drawer-top", { autoAlpha: 0, duration: 0.25 }, 7.75)
        .to("[data-robot-move]", { x: 125, duration: 1.15, ease: "power1.inOut" }, 7.6)
        .to("[data-robot-eyes]", { x: 6, duration: 0.25 }, 8)
        .to("[data-drawer-right='0']", { x: -48, y: 10, duration: 0.7 }, "codegraph")
        .to("[data-drawer-right='0'] .drawer-top", { autoAlpha: 1, duration: 0.3 }, "codegraph")
        .to("[data-arm-right]", { rotation: 23, duration: 0.4, yoyo: true, repeat: 5 }, 8.7)
        .to("[data-drawer-right='1']", { x: -30, y: 6, duration: 0.6 }, 9.9)
        .to("[data-drawer-right='1'] .drawer-top", { autoAlpha: 1, duration: 0.3 }, 9.9)
        .to("[data-drawer-right='2']", { x: -56, y: 10, duration: 0.65 }, 11.1);
      timeline.to("[data-drawer-right='2'] .drawer-top", { autoAlpha: 1, duration: 0.3 }, 11.1);

      function fileFlight(
        selector: string,
        at: number,
        duration: number,
        x: number,
        y: number,
        repeat: number,
      ): void {
        const flight = gsap.timeline({ repeat, repeatDelay: 0.06 });
        flight
          .fromTo(
            selector,
            { x: 0, y: 0, rotation: -12, scale: 0.75, autoAlpha: 0 },
            { autoAlpha: 1, duration: 0.06, immediateRender: false },
          )
          .to(selector, {
            x,
            y,
            rotation: x > 0 ? 18 : -18,
            scale: 0.85,
            duration: duration - 0.14,
            ease: "power1.inOut",
          })
          .to(selector, { autoAlpha: 0, duration: 0.08 });
        timeline.add(flight, at);
      }
      for (let index = 0; index < 3; index += 1) {
        fileFlight(`[data-file-left='${index}']`, 5.15 + index * 0.75, 1.15, 100, 88, 0);
        fileFlight(`[data-file-right='${index}']`, 9 + index * 0.75, 1.1, -90, 88, 0);
      }

      // A visible pickup, then an arm movement into the chest socket: the chip stays physical.
      timeline
        .fromTo(
          "[data-chip]",
          { autoAlpha: 0, y: 12, scale: 0.55 },
          { autoAlpha: 1, y: -80, scale: 1, duration: 0.75, ease: "back.out(1.3)" },
          "chip",
        )
        .to("[data-chip]", { x: -2, y: 7, duration: 0.6 }, 12.4)
        .to("[data-chip-label]", { autoAlpha: 0, duration: 0.2 }, 13)
        .to("[data-arm-right]", { rotation: 0, duration: 0.2 }, 12.8)
        .to(
          "[data-arm-right] path",
          { attr: { d: "M120 144q-14 27-37 17" }, duration: 0.7 },
          "integrate",
        )
        .to("[data-arm-right] circle", { attr: { cx: 83, cy: 161 }, duration: 0.7 }, "integrate")
        .to("[data-chip]", { x: -75, y: 51, scale: 0.45, duration: 0.7 }, "integrate")
        .to("[data-chip]", { autoAlpha: 0, duration: 0.15 }, 14)
        .to("[data-integrated-chip]", { autoAlpha: 1, duration: 0.15 }, 14)
        .fromTo(
          "[data-integration-ring]",
          { autoAlpha: 1, scale: 0.35 },
          {
            autoAlpha: 0,
            scale: 2,
            duration: 0.65,
            transformOrigin: "50% 50%",
            immediateRender: false,
          },
          14,
        )
        .to("[data-arm-right] path", { attr: { d: "M120 144q31 7 33-24" }, duration: 0.45 }, 14.4)
        .to("[data-arm-right] circle", { attr: { cx: 153, cy: 117 }, duration: 0.45 }, 14.4)
        .to("[data-robot-move]", { x: 0, duration: 0.7 }, 14.5)
        .to("[data-robot-eyes]", { x: 0, duration: 0.2 }, 14.5);

      // The same files now move in a quick, coordinated stream. No invented speed metric.
      timeline
        .to("[data-drawer-left='0']", { x: 42, y: 7, duration: 0.22 }, "fast-search")
        .to("[data-drawer-left='0'] .drawer-top", { autoAlpha: 1, duration: 0.15 }, "fast-search")
        .to("[data-drawer-right='0']", { x: -42, y: 7, duration: 0.22 }, "fast-search")
        .to("[data-speed-lines]", { autoAlpha: 0.75, duration: 0.2 }, 15)
        .to("[data-arm-left]", { rotation: -28, duration: 0.11, yoyo: true, repeat: 33 }, 15)
        .to("[data-arm-right]", { rotation: 28, duration: 0.11, yoyo: true, repeat: 33 }, 15)
        .to("[data-robot-body]", { rotation: 3, y: -3, duration: 0.13, yoyo: true, repeat: 27 }, 15)
        .to("[data-robot-eyes]", { x: -5, duration: 0.14, yoyo: true, repeat: 23 }, 15)
        .to("[data-speed-lines]", { x: -8, duration: 0.12, yoyo: true, repeat: 25 }, 15);
      for (let index = 0; index < 8; index += 1) {
        fileFlight(`[data-file-left='${index}']`, 15 + index * 0.09, 0.36, 235, 93 - index * 7, 7);
        fileFlight(
          `[data-file-right='${index}']`,
          15.05 + index * 0.09,
          0.36,
          -225,
          93 - index * 7,
          7,
        );
      }

      // Settle with the chip still installed, ready to continue in a later scene.
      timeline
        .to("[data-speed-lines]", { autoAlpha: 0, duration: 0.2 }, 18.8)
        .to(".drawer-top", { autoAlpha: 0, duration: 0.2 }, 19.3)
        .to(
          "[data-drawer-left], [data-drawer-right]",
          { x: 0, y: 0, duration: 0.4, stagger: 0.04 },
          19,
        )
        .to(
          "[data-arm-left], [data-arm-right], [data-robot-body]",
          { rotation: 0, y: 0, duration: 0.3 },
          19,
        )
        .to("[data-robot-eyes]", { x: 0, duration: 0.2 }, 19)
        .fromTo(
          "[data-ready]",
          { autoAlpha: 0, y: 10 },
          { autoAlpha: 1, y: 0, duration: 0.4 },
          19.2,
        );

      // Steps while walking are bounded to the two trips between the archives.
      for (const at of [4, 7.6]) {
        timeline
          .to("[data-leg-left]", { rotation: 16, duration: 0.16, yoyo: true, repeat: 5 }, at)
          .to("[data-leg-right]", { rotation: -16, duration: 0.16, yoyo: true, repeat: 5 }, at);
      }
      for (const at of [3.1, 6.3, 9.4, 14.2, 19.3]) {
        timeline.to(
          "[data-robot-eyes]",
          { scaleY: 0.08, duration: 0.07, yoyo: true, repeat: 1, transformOrigin: "50% 50%" },
          at,
        );
      }
      timeline.eventCallback("onUpdate", render);
      timeline.eventCallback("onComplete", render);
      toggle.hidden = reduced;
      controls.hidden = false;
      demo.classList.add("is-enhanced");

      toggle.addEventListener(
        "click",
        (): void => {
          started = true;
          if (timeline.time() >= DURATION - 0.01) timeline.restart();
          else if (timeline.paused()) timeline.play();
          else timeline.pause();
          render();
        },
        options,
      );
      scrub.addEventListener(
        "input",
        (): void => {
          started = true;
          timeline.pause().time(Number(scrub.value) / 1000, false);
          render();
        },
        options,
      );
      const observer = new IntersectionObserver(
        (entries: IntersectionObserverEntry[]): void => {
          visible = entries.some(
            (entry: IntersectionObserverEntry): boolean => entry.isIntersecting,
          );
          if (visible && !started && !reduced && !document.hidden) {
            started = true;
            timeline.play();
          } else if (!visible) timeline.pause();
          render();
        },
        { threshold: 0.25 },
      );
      observer.observe(demo);
      document.addEventListener(
        "visibilitychange",
        (): void => {
          if (document.hidden) {
            timeline.pause();
            render();
          }
        },
        options,
      );
      if (reduced) timeline.progress(1).pause();
      else timeline.time(0).pause();
      render();

      return (): void => {
        observer.disconnect();
        abort.abort();
      };
    },
    demo,
  );

  const dispose = (): void => media.revert();
  window.addEventListener("pagehide", dispose, { once: true });
  document.addEventListener("astro:before-swap", dispose, { once: true });
}
