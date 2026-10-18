import { copy } from '../copy';

interface LandingPageProps {
  onOpenChat: () => void;
  onOpenUpload: () => void;
  contributionsEnabled: boolean;
}

export function LandingPage({
  onOpenChat,
  onOpenUpload,
  contributionsEnabled,
}: LandingPageProps) {
  return (
    <section className="landing" aria-labelledby="landing-title">
      <div className="landing__orb landing__orb--one" aria-hidden="true" />
      <div className="landing__orb landing__orb--two" aria-hidden="true" />
      <div className="landing__grid" aria-hidden="true" />
      <div className="landing__content">
        <div className="brand-mark" aria-hidden="true">量</div>
        <p className="landing__eyebrow">{copy.landing.eyebrow}</p>
        <h1 id="landing-title">{copy.landing.headline}</h1>
        <p className="landing__description">{copy.landing.description}</p>
        <ul className="landing__chips" aria-label={copy.app.title}>
          <li>{copy.landing.knowledge}</li>
          <li>{copy.landing.reasoning}</li>
          <li>{copy.landing.contribution}</li>
        </ul>
        <button className="button button--primary landing__cta" data-testid="landing-cta" type="button" onClick={onOpenChat}>
          {copy.landing.start}
        </button>
        <button className="landing__upload" type="button" onClick={onOpenUpload} disabled={!contributionsEnabled} title={!contributionsEnabled ? copy.chat.uploadUnavailable : undefined}>
          {copy.landing.upload}
        </button>
        <p className="landing__privacy">{copy.landing.privacy}</p>
      </div>
    </section>
  );
}
