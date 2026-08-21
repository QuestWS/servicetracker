'use client';

import { useEffect, useState } from 'react';

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/**
 * Android offers to install a PWA through an event the page has to catch and
 * re-raise; iOS offers nothing and has to be told where the Share button is.
 * Either way this only shows in a browser tab — once the app is on the home
 * screen it runs standalone and the banner disappears.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(true);
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    const installed =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    setStandalone(installed);
    if (installed) return;

    setIosHelp(/iphone|ipad|ipod/i.test(navigator.userAgent));
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (standalone) return null;

  if (deferred) {
    return (
      <div className="banner info" style={{ marginBottom: 14 }}>
        <b>Add this to your home screen</b> so you can open it like any other app.
        <button
          className="btn navy sm block"
          type="button"
          style={{ marginTop: 10 }}
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
        >
          Install
        </button>
      </div>
    );
  }

  if (iosHelp) {
    return (
      <div className="banner info" style={{ marginBottom: 14 }}>
        <b>Add this to your home screen:</b> tap the Share button below, then{' '}
        <b>Add to Home Screen</b>. You only have to do this once.
      </div>
    );
  }
  return null;
}
