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

/** Small drawn glyphs for the capability sheet: lens, trail, stacked sheets. */
function CapabilityGlyph({ kind }: { kind: 'knowledge' | 'reasoning' | 'contribution' }) {
  return (
    <svg className="capability__glyph" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      {kind === 'knowledge' ? <><circle cx="12" cy="12" r="7" /><path d="M17 17l6 6M9 12h6M12 9v6" /></> : null}
      {kind === 'reasoning' ? <><path d="M5 21l7-8 5 4 6-11" /><circle cx="5" cy="21" r="1.8" /><circle cx="12" cy="13" r="1.8" /><circle cx="17" cy="17" r="1.8" /><circle cx="23" cy="6" r="1.8" /></> : null}
      {kind === 'contribution' ? <><path d="M7 9h14v14H7z" /><path d="M10 6h14v14" /><path d="M14 13v6M11 16h6" /></> : null}
    </svg>
  );
}

const capabilities = [
  { kind: 'knowledge', text: copy.landing.knowledge },
  { kind: 'reasoning', text: copy.landing.reasoning },
  { kind: 'contribution', text: copy.landing.contribution },
] as const;

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

  const { phase, skip } = intro;
  useEffect(() => {
    // Escape also ends the intro, alongside the visible button.
    if (phase === 'landing') return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') skip(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, skip]);

  // One reveal sequence: the left column top to bottom, then the capability sheet on the right.
  let cursor = 1;
  const take = (text: string): number => { const order = cursor; cursor += splitFragments(text).length; return order; };
  const slot = (): CSSProperties => ({ '--i': cursor++ } as CSSProperties);
  const order = {
    eyebrow: take(copy.landing.eyebrow),
    headline: take(copy.landing.headline),
    description: take(copy.landing.description),
    actions: slot(),
    privacy: take(copy.landing.privacy),
    sheet: slot(),
    capabilities: capabilities.map((item) => take(item.text)),
  };

  return (
    <section className="landing" data-intro={intro.phase} aria-labelledby="landing-title">
      {intro.phase !== 'landing' ? (
        <div className="intro" data-phase={intro.phase}>
          <p className="intro-line" lang="en">{INTRO_LINE}</p>
          <button className="intro-skip" type="button" lang="en" aria-keyshortcuts="Escape" onClick={intro.skip}>Skip intro</button>
        </div>
      ) : null}
      <div className="landing__content">
        <div className="landing__masthead reveal-item" style={{ '--i': 0 } as CSSProperties}>
          <div className="brand-mark" aria-hidden="true">量</div>
          <span className="landing__scale" aria-hidden="true" />
        </div>
        <p className="landing__eyebrow"><RevealText text={copy.landing.eyebrow} order={order.eyebrow} /></p>
        <h1 id="landing-title"><RevealText text={copy.landing.headline} order={order.headline} /></h1>
        <p className="landing__description"><RevealText text={copy.landing.description} order={order.description} /></p>
        <div className="landing__sheet reveal-item" style={order.sheet}>
          <span className="landing__sheet-scale" aria-hidden="true" />
          <ul className="landing__chips" aria-label={copy.app.title}>
            {capabilities.map((item, index) => (
              <li key={item.kind}>
                <CapabilityGlyph kind={item.kind} />
                <RevealText text={item.text} order={order.capabilities[index]} />
              </li>
            ))}
          </ul>
        </div>
        <div className="landing__actions reveal-item" style={order.actions}>
          <button ref={ctaRef} className="button button--primary landing__cta" data-testid="landing-cta" type="button" onClick={onOpenChat}>
            {copy.landing.start}
          </button>
          <button className="landing__upload" type="button" onClick={onOpenUpload} disabled={!contributionsEnabled} title={!contributionsEnabled ? copy.chat.uploadUnavailable : undefined}>
            {copy.landing.upload}
          </button>
        </div>
        <p className="landing__privacy"><RevealText text={copy.landing.privacy} order={order.privacy} /></p>
      </div>
    </section>
  );
}
