// Evaluate this expression in a running local WildBots preview. It creates and
// removes its own sandbox, exercises the actual server policy, and returns facts.
(async () => {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw Error('Use a local fixture only.');
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-scripts';
  frame.src = '/inline-ui';
  frame.hidden = true;
  const report = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(Error('Inline sandbox probe timed out')); }, 10000);
    function cleanup() { clearTimeout(timeout); removeEventListener('message', receive); frame.remove(); }
    const probe = async () => {
      const checks = {};
      try { void top.document.body; checks.parentDomBlocked = false; } catch { checks.parentDomBlocked = true; }
      try { void document.cookie; checks.cookiesBlocked = false; } catch { checks.cookiesBlocked = true; }
      try { localStorage.setItem('inline-probe', '1'); checks.storageBlocked = false; } catch { checks.storageBlocked = true; }
      try { await fetch(location.ancestorOrigins[location.ancestorOrigins.length - 1] + '/api/bootstrap?inline-probe'); checks.fetchBlocked = false; } catch { checks.fetchBlocked = true; }
      parent.parent.postMessage({ type: 'inline-probe-result', checks }, '*');
      // Inspect browser diagnostics after this check: frame-src about: must block
      // this navigation before any external request, even though the child owns its location.
      setTimeout(() => { location.href = 'https://example.invalid/inline-ui-navigation-probe'; }, 20);
    };
    function receive(event) {
      if (event.source === frame.contentWindow && event.data?.type === 'wildbots-ready') frame.contentWindow.postMessage({ type: 'wildbots-init', html: '<!doctype html><html><body><script>(' + probe.toString() + ')()</script></body></html>' }, '*');
      if (event.source === frame.contentWindow?.frames[0] && event.data?.type === 'inline-probe-result') { setTimeout(() => { cleanup(); resolve(event.data); }, 250); }
    }
    addEventListener('message', receive);
    document.body.append(frame);
  });
  if (!Object.values(report.checks).every(Boolean)) throw Error(JSON.stringify(report));
  return report;
})()
