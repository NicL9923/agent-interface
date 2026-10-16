import type { FastifyInstance } from "fastify";
import { inlineUiPolicy } from "../shared/inline-ui.js";

// Only this static bootstrap gets an inline-script policy. Reply HTML never enters
// a URL, server log, or the host DOM. A second sandbox retains a trusted relay.
export const inlineUiShell = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}iframe{display:block;width:100%;height:100vh;border:0}</style></head><body><iframe sandbox="allow-scripts" title="Interactive content" referrerpolicy="no-referrer"></iframe><script>
(() => {
  const frame = document.querySelector('iframe');
  let initialized = false;
  addEventListener('message', event => {
    if (event.source === frame.contentWindow) {
      if (event.data?.type === 'wildbots-size' && Number.isFinite(event.data.height)) parent.postMessage({type:'wildbots-size',height:event.data.height}, '*');
      if (event.data?.type === 'wildbots-loaded') parent.postMessage({type:'wildbots-loaded'}, '*');
      return;
    }
    if (event.source !== parent) return;
    if (event.data?.type === 'wildbots-theme' && initialized) { document.documentElement.style.colorScheme = event.data.colorScheme === 'dark' ? 'dark' : 'light'; frame.contentWindow.postMessage(event.data, '*'); return; }
    if (initialized || event.data?.type !== 'wildbots-init' || typeof event.data.html !== 'string' || event.data.html.length > 100000) return;
    initialized = true;
    frame.srcdoc = \`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${inlineUiPolicy}"><style>html{color:var(--foreground,#282c27);font:15px system-ui;background:transparent}body{margin:0;display:flow-root;overflow-wrap:anywhere}*{box-sizing:border-box}img,svg,canvas{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}input,select,textarea{max-width:100%}:focus-visible{outline:2px solid var(--primary,#246f59);outline-offset:3px}</style><script>(\` + (() => {
      addEventListener('message', event => {
        if (event.source !== parent || event.data?.type !== 'wildbots-theme') return;
        document.documentElement.style.colorScheme = event.data.colorScheme === 'dark' ? 'dark' : 'light';
        for (const [name, value] of Object.entries(event.data.variables || {})) if (/^--[a-z-]+$/.test(name) && typeof value === 'string') document.documentElement.style.setProperty(name, value);
      });
      let last = 0, scheduled = false;
      const measure = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const height = Math.ceil(document.body.getBoundingClientRect().height);
          if (height !== last) { last = height; parent.postMessage({type:'wildbots-size',height}, '*'); }
        });
      };
      addEventListener('DOMContentLoaded', () => {
        new ResizeObserver(measure).observe(document.body);
        parent.postMessage({type:'wildbots-loaded'}, '*'); measure();
      });
      addEventListener('resize', measure);
    }).toString() + ')()<\\/script></head><body>' + event.data.html + '</body></html>';
  });
  parent.postMessage({type:'wildbots-ready'}, '*');
})();
</script></body></html>`;

export const inlineUiShellPolicy = inlineUiPolicy.replace("frame-src 'none'", "frame-src about:") + "; sandbox allow-scripts; frame-ancestors 'self'";
export function installInlineUi(app: FastifyInstance) {
  app.get("/inline-ui", async (_request, reply) => reply
    .header("Content-Security-Policy", inlineUiShellPolicy)
    .header("X-Frame-Options", "SAMEORIGIN")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-DNS-Prefetch-Control", "off")
    .type("text/html").send(inlineUiShell));
}
