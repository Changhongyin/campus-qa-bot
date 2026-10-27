import { useEffect, useRef, type CSSProperties } from 'react';
import { copy } from '../copy';
import { useIntroSequence } from '../hooks/useIntroSequence';
import { RevealText, splitFragments } from './RevealText';

interface LandingPageProps {
  onOpenChat: () => void;
  onOpenUpload: () => void;
  contributionsEnabled: boolean;
  /** True while the landing view is the current view. */
  active: boolean;
}

const INTRO_LINE = 'Welcome to China Jiliang University';

export function LandingPage({
  onOpenChat,
  onOpenUpload,
  contributionsEnabled,
  active,
}: LandingPageProps) {
  const intro = useIntroSequence();
  const ctaRef = useRef<HTMLButtonElement>(null);
  const wasActive = useRef(active);

  useEffect(() => {
    // Returning from chat: put focus back on the main action.
    if (active && !wasActive.current) ctaRef.current?.focus({ preventScroll: true });
    wasActive.current = active;
  }, [active]);

  // Assign every fragment a slot in one left-to-right, top-to-bottom sequence.
  let cursor = 1;
  const next = (text: string): number => { const order = cursor; cursor += splitFragments(text).length; return order; };
  const slot = (): CSSProperties => ({ '--i': cursor++ } as CSSProperties);

  return (
    <section className="landing" data-intro={intro.phase} aria-labelledby="landing-title">
      {intro.phase !== 'landing' ? (
        <div className="intro" data-phase={intro.phase}>
          <p className="intro-line" lang="en">{INTRO_LINE}</p>
          <button className="intro-skip" type="button" lang="en" onClick={intro.skip}>Skip intro</button>
        </div>
      ) : null}
      <div className="landing__content">
        <div className="landing__masthead reveal-item" style={{ '--i': 0 } as CSSProperties}>
          <div className="brand-mark" aria-hidden="true">量</div>
          <span className="landing__scale" aria-hidden="true" />
        </div>
        <p className="landing__eyebrow"><RevealText text={copy.landing.eyebrow} order={next(copy.landing.eyebrow)} /></p>
        <h1 id="landing-title"><RevealText text={copy.landing.headline} order={next(copy.landing.headline)} /></h1>
        <p className="landing__description"><RevealText text={copy.landing.description} order={next(copy.landing.description)} /></p>
        <ul className="landing__chips" aria-label={copy.app.title}>
          {[copy.landing.knowledge, copy.landing.reasoning, copy.landing.contribution].map((item) => (
            <li key={item}><RevealText text={item} order={next(item)} /></li>
          ))}
        </ul>
        <div className="landing__actions reveal-item" style={slot()}>
          <button ref={ctaRef} className="button button--primary landing__cta" data-testid="landing-cta" type="button" onClick={onOpenChat}>
            {copy.landing.start}
          </button>
          <button className="landing__upload" type="button" onClick={onOpenUpload} disabled={!contributionsEnabled} title={!contributionsEnabled ? copy.chat.uploadUnavailable : undefined}>
            {copy.landing.upload}
          </button>
        </div>
        <p className="landing__privacy"><RevealText text={copy.landing.privacy} order={next(copy.landing.privacy)} /></p>
      </div>
    </section>
  );
}
