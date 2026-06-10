/**
 * JS→native reply transport for injected scripts.
 *
 * The Capgo plugin's `window.mobileApp.postMessage` → `messageFromWebview` channel does not reliably
 * deliver on this WebView/plugin build (the probe shows `postMessage` runs but the native event never
 * fires). The `consoleMessage` channel, however, works. So injected scripts emit their reply BOTH ways:
 * via `postMessage` (fast path, if it ever works) and via chunked `console.log` lines that the bridge
 * reassembles. Chunking keeps each console line well under any per-message size cap.
 *
 * Wire format (one chunk per console line), bracketed by start+end sentinels so the bridge can locate
 * it even if the page wraps `console.*` to prepend/append text:
 *   `@@HPB@@<requestId>@@<seq>@@<total>@@<jsonChunk>@@HPE@@`
 * `requestId`, `seq`, `total` never contain `@@`; the JSON chunk is between the last header `@@` and
 * the `@@HPE@@` terminator.
 */
export const BRIDGE_CONSOLE_PREFIX = "@@HPB@@";
export const BRIDGE_CONSOLE_SUFFIX = "@@HPE@@";

/** Max characters per console chunk (conservative, to survive any platform console truncation). */
const BRIDGE_CHUNK_SIZE = 2000;

/**
 * Source for an `__hpEmit(RID, obj)` function to inline at the top of each injected IIFE. It posts the
 * reply over both transports; the bridge resolves on whichever arrives first. The `[hpinj] emit` line
 * is a diagnostic so we can see the reply leave the page even if reassembly later fails.
 */
export function bridgeEmitFnSource(): string {
  return (
    "function __hpEmit(RID,obj){" +
    "try{if(window.mobileApp&&typeof window.mobileApp.postMessage==='function'){window.mobileApp.postMessage(obj);}}catch(e){}" +
    "try{var s=JSON.stringify(obj);var CH=" +
    BRIDGE_CHUNK_SIZE +
    ";var total=Math.ceil(s.length/CH)||1;" +
    "try{console.log('[hpinj] emit rid='+RID+' type='+(obj&&obj.type)+' len='+s.length+' chunks='+total);}catch(_){}" +
    "for(var i=0;i<total;i++){console.log('" +
    BRIDGE_CONSOLE_PREFIX +
    "'+RID+'@@'+i+'@@'+total+'@@'+s.substr(i*CH,CH)+'" +
    BRIDGE_CONSOLE_SUFFIX +
    "');}}" +
    "catch(e){try{console.error('[hpinj] emit failed: '+(e&&e.message?e.message:e));}catch(_){}}" +
    "}"
  );
}
